import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { BridgeError, buildSafeChildEnv, runSubprocess } from '../src/drivers/base.mjs';
import { createClaudeDriver } from '../src/drivers/claude.mjs';
import { createCodexDriver } from '../src/drivers/codex.mjs';
import { createGeminiDriver } from '../src/drivers/gemini.mjs';
import { createOpencodeDriver } from '../src/drivers/opencode.mjs';
import { createStdioJsonDriver } from '../src/drivers/stdio-json.mjs';
import { buildBridgePrompt, createCallIdGenerator, parseCliModelOutput } from '../src/protocol.mjs';
import { createBridgeApp } from '../src/server.mjs';

const TOOLS = [
  { type: 'function', function: { name: 'terminal', description: 'run', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'done', description: 'finish', parameters: { type: 'object' } } },
];

function makeFakeBinary(dir, name, jsBody) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${jsBody}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

test('buildSafeChildEnv strips all CLI_BRIDGE_* secrets while preserving standard vars', () => {
  const clean = buildSafeChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/node',
    CLI_BRIDGE_API_KEY: 'top-secret',
    CLI_BRIDGE_REDACT_VALUES: 'secret-2',
    OTHER_VAR: 'ok',
  });
  assert.equal(clean.PATH, '/usr/bin');
  assert.equal(clean.OTHER_VAR, 'ok');
  assert.equal('CLI_BRIDGE_API_KEY' in clean, false);
  assert.equal('CLI_BRIDGE_REDACT_VALUES' in clean, false);
});

test('protocol enforces tool_choice=none, forced tool_choice, response_format=json_object, prose quotes/braces, and non-object args', () => {
  const nextId = createCallIdGenerator();

  // tool_choice === 'none' suppresses tool_calls and skips tool schema prompt
  const promptNone = buildBridgePrompt({
    messages: [{ role: 'user', content: 'just reply' }],
    tools: TOOLS,
    toolChoice: 'none',
  });
  assert.doesNotMatch(promptNone, /## PentAGI Tool Execution Contract/);

  const suppressed = parseCliModelOutput(
    { content: 'plain text', tool_calls: [{ name: 'done', arguments: {} }] },
    TOOLS,
    nextId,
    { toolChoice: 'none' }
  );
  assert.equal(suppressed.finishReason, 'stop');
  assert.equal(suppressed.toolCalls.length, 0);
  assert.equal(suppressed.content, 'plain text');

  // Forced tool_choice rejects non-matching tools even if present in tools[]
  const forcedMismatch = parseCliModelOutput(
    JSON.stringify({ content: null, tool_calls: [{ name: 'terminal', arguments: {} }] }),
    TOOLS,
    nextId,
    { toolChoice: { type: 'function', function: { name: 'done' } } }
  );
  assert.equal(forcedMismatch.toolCalls.length, 0);
  // Must NOT leak the raw '{"content":null,"tool_calls":...}' wrapper string
  assert.equal(forcedMismatch.content, '');

  // Prose containing stray quotes and braces + multiple code fences + array arguments normalization
  const tricky = [
    'Use a 24" monitor } here is a bash snippet:',
    '```bash\necho hi\n```',
    '```json\n{"content": null, "tool_calls": [{"name": "done", "arguments": [1, 2, 3]}]}\n```',
  ].join('\n');
  const parsedTricky = parseCliModelOutput(tricky, TOOLS, nextId);
  assert.equal(parsedTricky.finishReason, 'tool_calls');
  assert.equal(parsedTricky.toolCalls[0].function.name, 'done');
  assert.equal(parsedTricky.toolCalls[0].function.arguments, '[1,2,3]');

  // response_format: json_object unwraps Markdown fences
  const jsonPrompt = buildBridgePrompt({
    messages: [{ role: 'user', content: 'return json' }],
    responseFormat: { type: 'json_object' },
  });
  assert.match(jsonPrompt, /single valid raw JSON object/i);
  const jsonParsed = parseCliModelOutput('```json\n{"ok": true, "score": 5}\n```', [], nextId, {
    responseFormat: { type: 'json_object' },
  });
  assert.equal(jsonParsed.content, '{"ok":true,"score":5}');
});

test('driver error envelopes (claude is_error, codex turn.failed, gemini prelude+error, stdio-json text) are handled cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-hard-'));
  try {
    const claudeErr = makeFakeBinary(
      dir,
      'claude-err',
      `
      const args = process.argv.slice(2);
      if (!args.includes('--strict-mcp-config') || !args.includes('--setting-sources')) process.exit(99);
      process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'quota exceeded' }));
      `
    );
    const codexErr = makeFakeBinary(
      dir,
      'codex-err',
      `process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'sandbox denied' } }) + '\\n');`
    );
    const geminiPrelude = makeFakeBinary(
      dir,
      'gemini-prelude',
      `
      process.stdout.write('Loaded cached credentials.\\n');
      process.stdout.write(JSON.stringify({
        response: 'hello from gemini',
        stats: { models: { 'gemini-2.5-pro-preview': { tokens: { prompt: 11, candidates: 7 } } } }
      }));
      `
    );
    const geminiErr = makeFakeBinary(
      dir,
      'gemini-err',
      `process.stdout.write(JSON.stringify({ error: { message: 'invalid model' } }));`
    );
    const stdioTextOnly = makeFakeBinary(
      dir,
      'stdio-text',
      `process.stdout.write(JSON.stringify({ text: 'from text field', usage: { prompt_tokens: 3, completion_tokens: 2 } }));`
    );

    const cfg = loadConfig({
      CLI_BRIDGE_ENABLED_DRIVERS: 'claude,codex,gemini,stdio-json',
      CLI_BRIDGE_CLAUDE_BIN: claudeErr,
      CLI_BRIDGE_CODEX_BIN: codexErr,
      CLI_BRIDGE_GEMINI_BIN: geminiPrelude,
      CLI_BRIDGE_STDIO_JSON_BIN: stdioTextOnly,
    });

    await assert.rejects(
      () => createClaudeDriver(cfg).invoke({ model: 'sonnet', prompt: 'hi' }),
      (err) => err instanceof BridgeError && err.code === 'cli_driver_error' && /quota exceeded/.test(err.message)
    );

    await assert.rejects(
      () => createCodexDriver(cfg).invoke({ model: 'gpt-5', prompt: 'hi' }),
      (err) => err instanceof BridgeError && err.code === 'cli_driver_error' && /sandbox denied/.test(err.message)
    );

    const gemOk = await createGeminiDriver(cfg).invoke({ model: 'gemini-2.5-pro', prompt: 'hi' });
    assert.equal(gemOk.text, 'hello from gemini');
    assert.equal(gemOk.usage.prompt_tokens, 11);
    assert.equal(gemOk.usage.completion_tokens, 7);

    const cfgGemErr = { ...cfg, binaries: { ...cfg.binaries, gemini: geminiErr } };
    await assert.rejects(
      () => createGeminiDriver(cfgGemErr).invoke({ model: 'gemini-2.5-pro', prompt: 'hi' }),
      (err) => err instanceof BridgeError && err.code === 'cli_driver_error' && /invalid model/.test(err.message)
    );

    const stdioOut = await createStdioJsonDriver(cfg).invoke({
      model: 'default',
      prompt: 'hi',
      messages: [],
      tools: [],
      toolChoice: 'auto',
    });
    const parsedStdio = parseCliModelOutput(stdioOut, [], createCallIdGenerator());
    assert.equal(parsedStdio.content, 'from text field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode error envelope, empty JSONL, and slash model argv are handled cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-'));
  try {
    const seenPathFile = join(dir, 'seen-prompt-path');
    const opencodeErr = makeFakeBinary(
      dir,
      'opencode-err',
      `
      const fs = require('node:fs');
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const required = ['run', '--standalone', '--format', 'json', '--archived', '--agent', 'pentagi', '--model'];
        if (!required.every((flag) => process.argv.includes(flag))) process.exit(45);
        if (process.argv.includes('plan')) process.exit(49);
        const model = process.argv[process.argv.indexOf('--model') + 1];
        if (model !== 'opencode-go/gpt-5.6-luna') process.exit(46);
        if (process.argv.includes('Reply with ONLY OK') || process.argv.includes('verbatim-system')) process.exit(47);
        if (Buffer.concat(chunks).toString('utf8') !== 'user-turn') process.exit(48);
        if (process.env.CLI_BRIDGE_API_KEY) process.exit(50);
        const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '');
        if (!cfg.agent || !cfg.agent.pentagi || cfg.agent.pentagi.tools['*'] !== false) process.exit(51);
        const prompt = cfg.agent.pentagi.prompt;
        if (!prompt.startsWith('{file:') || !prompt.endsWith('}')) process.exit(52);
        const promptPath = prompt.slice('{file:'.length, -1);
        if (fs.readFileSync(promptPath, 'utf8') !== 'verbatim-system') process.exit(53);
        if ((fs.statSync(promptPath).mode & 0o777) !== 0o600) process.exit(54);
        if (process.env.OPENCODE_CONFIG_CONTENT.includes('verbatim-system')) process.exit(55);
        fs.writeFileSync(${JSON.stringify(seenPathFile)}, promptPath);
        process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'partial' } }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'error', error: { type: 'ProviderAuthError', message: 'opencode auth expired' } }) + '\\n');
      });
      `
    );
    const opencodeEmpty = makeFakeBinary(
      dir,
      'opencode-empty',
      `process.stdout.write(JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 0, cache: { read: 2, write: 0 } } } }) + '\\n');`
    );

    const cfg = loadConfig({
      CLI_BRIDGE_ENABLED_DRIVERS: 'opencode',
      CLI_BRIDGE_OPENCODE_BIN: opencodeErr,
      CLI_BRIDGE_OPENCODE_MODELS: 'opencode-go/gpt-5.6-luna',
    });

    const previousKey = process.env.CLI_BRIDGE_API_KEY;
    process.env.CLI_BRIDGE_API_KEY = 'should-not-leak';
    try {
      await assert.rejects(
        () =>
          createOpencodeDriver(cfg).invoke({
            model: 'opencode-go/gpt-5.6-luna',
            prompt: 'Reply with ONLY OK',
            systemPrompt: 'verbatim-system',
            userPrompt: 'user-turn',
          }),
        (err) =>
          err instanceof BridgeError &&
          err.status === 502 &&
          err.code === 'cli_driver_error' &&
          err.type === 'server_error' &&
          /opencode auth expired/.test(err.message)
      );
    } finally {
      if (previousKey === undefined) delete process.env.CLI_BRIDGE_API_KEY;
      else process.env.CLI_BRIDGE_API_KEY = previousKey;
    }
    const seenPromptPath = readFileSync(seenPathFile, 'utf8');
    assert.equal(existsSync(seenPromptPath), false);

    const cfgEmpty = { ...cfg, binaries: { ...cfg.binaries, opencode: opencodeEmpty } };
    await assert.rejects(
      () => createOpencodeDriver(cfgEmpty).invoke({ model: 'opencode-go/gpt-5.6-luna', prompt: 'hi' }),
      (err) => err instanceof BridgeError && err.status === 502 && err.code === 'malformed_cli_output'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process-group cancellation kills grandchildren holding stdout open without hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-pg-'));
  try {
    const spawner = makeFakeBinary(
      dir,
      'spawner',
      `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      setTimeout(() => {}, 30000);
      `
    );

    const started = Date.now();
    await assert.rejects(
      () => runSubprocess({ binary: spawner, timeoutMs: 250, killGraceMs: 100 }),
      (err) => err instanceof BridgeError && err.code === 'cli_timeout'
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `expected fast process-group teardown, took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP server handles malformed URLs safely, enforces auth on unprefixed routes, streams tool_calls+usage+emoji, and redacts 200 OK outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-srv-hard-'));
  const fakeClaude = makeFakeBinary(
    dir,
    'fake-claude',
    `
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      if (process.env.CLI_BRIDGE_API_KEY) {
        process.stdout.write(JSON.stringify({ result: 'ENV_LEAKED' }));
        return;
      }
      const prompt = Buffer.concat(chunks).toString('utf8');
      if (prompt.includes('STREAM_TOOL')) {
        process.stdout.write(JSON.stringify({
          result: JSON.stringify({ content: null, tool_calls: [{ name: 'done', arguments: { result: 'ok with red-secret-777 and quote\\"slash\\\\tok' } }] }),
          usage: { input_tokens: 21, output_tokens: 9 }
        }));
        return;
      }
      process.stdout.write(JSON.stringify({
        result: '🚀'.repeat(40) + ' red-secret-777',
        usage: { input_tokens: 10, output_tokens: 5 }
      }));
    });
    `
  );

  const cfg = loadConfig({
    CLI_BRIDGE_PORT: '0',
    CLI_BRIDGE_API_KEY: 'bridge-key-1234',
    CLI_BRIDGE_ENABLED_DRIVERS: 'claude',
    CLI_BRIDGE_CLAUDE_BIN: fakeClaude,
    CLI_BRIDGE_REDACT_VALUES: 'red-secret-777,quote"slash\\tok',
  });
  const app = createBridgeApp(cfg, { logger: { error() {}, log() {} } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Pre-auth malformed request target returns 400 and does NOT crash process
    const badUrlStatus = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '//[::1', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badUrlStatus, 400);

    // 2. Unprefixed /models requires Bearer auth and works when authenticated
    assert.equal((await fetch(`${baseUrl}/models`)).status, 401);
    const unprefixedModels = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    assert.equal(unprefixedModels.status, 200);

    // 3. SSE tool_calls + usage chunk + 200 OK secret redaction
    const sseToolRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'STREAM_TOOL' }],
        tools: TOOLS,
      }),
    });
    assert.equal(sseToolRes.status, 200);
    const sseToolText = await sseToolRes.text();
    assert.match(sseToolText, /"tool_calls":\[\{"index":0,"id":"call_[0-9a-f]{24}"/);
    assert.match(sseToolText, /"usage":\{"prompt_tokens":21,"completion_tokens":9,"total_tokens":30\}/);
    assert.doesNotMatch(sseToolText, /red-secret-777/);
    assert.doesNotMatch(sseToolText, /quote/);
    assert.match(sseToolText, /\[REDACTED\]/);

    // 4. SSE emoji streaming preserves 4-byte code points without lone-surrogate corruption
    const sseEmojiRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'EMOJI' }],
      }),
    });
    const sseEmojiText = await sseEmojiRes.text();
    const reassembled = sseEmojiText
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices?.[0]?.delta?.content || '')
      .join('');
    assert.equal(reassembled, `${'🚀'.repeat(40)} [REDACTED]`);
    assert.doesNotMatch(reassembled, /ENV_LEAKED/);
  } finally {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
