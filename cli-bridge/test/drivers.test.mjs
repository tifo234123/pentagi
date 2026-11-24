import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { BridgeError, DriverRegistry, assertSafeModelName, runSubprocess } from '../src/drivers/base.mjs';
import { createClaudeDriver } from '../src/drivers/claude.mjs';
import { createCodexDriver } from '../src/drivers/codex.mjs';
import { createGeminiDriver } from '../src/drivers/gemini.mjs';
import { createOpencodeDriver } from '../src/drivers/opencode.mjs';
import { createStdioJsonDriver } from '../src/drivers/stdio-json.mjs';

function makeFakeBinary(dir, name, jsBody) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${jsBody}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

test('loadConfig defaults to zero enabled drivers and validates unknown/unlisted default drivers', () => {
  const empty = loadConfig({});
  assert.deepEqual(empty.enabledDrivers, []);
  assert.equal(empty.port, 8090);

  assert.throws(() => loadConfig({ CLI_BRIDGE_ENABLED_DRIVERS: 'unknown-cli' }), /Unknown driver/);
  assert.throws(
    () => loadConfig({ CLI_BRIDGE_ENABLED_DRIVERS: 'claude', CLI_BRIDGE_DEFAULT_DRIVER: 'codex' }),
    /must also be listed/
  );
});

test('assertSafeModelName blocks flag injection and malformed model strings', () => {
  assert.equal(assertSafeModelName('sonnet'), 'sonnet');
  assert.equal(assertSafeModelName('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.throws(() => assertSafeModelName('--dangerously-skip-permissions'), BridgeError);
  assert.throws(() => assertSafeModelName('foo;rm -rf /'), BridgeError);
  assert.throws(() => assertSafeModelName(''), BridgeError);
});

test('DriverRegistry enforces explicit allowlist and exposes only enabled models', () => {
  const cfg = loadConfig({
    CLI_BRIDGE_ENABLED_DRIVERS: 'claude',
    CLI_BRIDGE_CLAUDE_MODELS: 'sonnet,opus',
  });
  const registry = new DriverRegistry(cfg, [
    createClaudeDriver(cfg),
    createCodexDriver(cfg),
    createGeminiDriver(cfg),
    createStdioJsonDriver(cfg),
  ]);

  const modelEntries = registry.listModels();
  assert.deepEqual(
    modelEntries.map((m) => m.id),
    ['claude/sonnet', 'claude/opus']
  );
  assert.equal(modelEntries[0].context_window, 200_000);
  assert.equal(modelEntries[0].max_output_tokens, 64_000);

  const ok = registry.resolve('claude/sonnet');
  assert.equal(ok.driver.id, 'claude');
  assert.equal(ok.model, 'sonnet');

  assert.throws(() => registry.resolve('codex/gpt-5'), (err) => err instanceof BridgeError && err.status === 403);
  assert.throws(() => registry.resolve('sonnet'), (err) => err instanceof BridgeError && err.status === 400);
});

test('claude, codex, gemini, and stdio-json drivers pass no-host-tool flags and parse outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-drivers-'));
  try {
    const fakeClaude = makeFakeBinary(
      dir,
      'fake-claude',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const hasDisabledTools = args.includes('--tools') && args[args.indexOf('--tools') + 1] === '';
        const sysIdx = args.indexOf('--system-prompt-file');
        const hasSys = sysIdx !== -1 && fs.readFileSync(args[sysIdx + 1], 'utf8').includes('PentAGI system');
        const hasSchema = args.includes('--json-schema');
        if (!hasDisabledTools || !hasSys || !hasSchema) process.exit(42);
        process.stdout.write(JSON.stringify({
          type: 'result',
          structured_output: { content: null, tool_calls: [{ name: 'done', arguments: { result: 'from-claude' } }] },
          usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 8 }
        }));
      });
      `
    );

    const fakeCodex = makeFakeBinary(
      dir,
      'fake-codex',
      `
      const args = process.argv.slice(2);
      const required = ['read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema'];
      if (!required.every((f) => args.includes(f))) process.exit(43);
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n');
        process.stdout.write(JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'codex-answer' },
          usage: { input_tokens: 20, output_tokens: 9 }
        }) + '\\n');
      });
      `
    );

    const fakeGemini = makeFakeBinary(
      dir,
      'fake-gemini',
      `
      const args = process.argv.slice(2);
      if (!args.includes('--approval-mode') || !args.includes('plan')) process.exit(44);
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({
          response: 'gemini-answer',
          stats: { models: { 'gemini-2.5-pro': { tokens: { prompt: 30, candidates: 11 } } } }
        }));
      });
      `
    );

    const fakeStdio = makeFakeBinary(
      dir,
      'fake-stdio',
      `
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        process.stdout.write(JSON.stringify({
          content: 'echo:' + req.protocol + ':' + req.model,
          usage: { prompt_tokens: 5, completion_tokens: 4 }
        }));
      });
      `
    );

    const cfg = loadConfig({
      CLI_BRIDGE_ENABLED_DRIVERS: 'claude,codex,gemini,stdio-json',
      CLI_BRIDGE_CLAUDE_BIN: fakeClaude,
      CLI_BRIDGE_CODEX_BIN: fakeCodex,
      CLI_BRIDGE_GEMINI_BIN: fakeGemini,
      CLI_BRIDGE_STDIO_JSON_BIN: fakeStdio,
    });

    const sampleSchema = { type: 'object', properties: { content: { type: ['string', 'null'] }, tool_calls: { type: 'array' } } };
    const claudeRes = await createClaudeDriver(cfg).invoke({
      model: 'sonnet',
      prompt: 'hello',
      systemPrompt: 'PentAGI system prompt',
      userPrompt: 'hello',
      jsonSchema: sampleSchema,
    });
    assert.equal(claudeRes.tool_calls[0].arguments.result, 'from-claude');
    assert.equal(claudeRes.usage.prompt_tokens, 15);

    const codexRes = await createCodexDriver(cfg).invoke({ model: 'gpt-5', prompt: 'hello', jsonSchema: sampleSchema });
    assert.equal(codexRes.text, 'codex-answer');
    assert.equal(codexRes.usage.completion_tokens, 9);

    const geminiRes = await createGeminiDriver(cfg).invoke({ model: 'gemini-2.5-pro', prompt: 'hello' });
    assert.equal(geminiRes.text, 'gemini-answer');
    assert.equal(geminiRes.usage.prompt_tokens, 30);

    const stdioRes = await createStdioJsonDriver(cfg).invoke({
      model: 'custom-v1',
      prompt: 'hi',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: 'auto',
    });
    assert.equal(stdioRes.content, 'echo:pentagi-cli-bridge/v1:custom-v1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode driver strips the driver prefix, uses the pentagi agent, concatenates text, and sums cache tokens', async () => {
  const cfg = loadConfig({
    CLI_BRIDGE_ENABLED_DRIVERS: 'opencode',
    CLI_BRIDGE_OPENCODE_BIN: '/usr/bin/opencode',
    CLI_BRIDGE_OPENCODE_MODELS: 'opencode-go/gpt-5.6-luna,opencode-go/claude-haiku-5-5',
    CLI_BRIDGE_WORK_DIR: '/work',
    CLI_BRIDGE_TIMEOUT_MS: '90000',
    CLI_BRIDGE_KILL_GRACE_MS: '1500',
    CLI_BRIDGE_MAX_OUTPUT_BYTES: '65536',
  });
  assert.equal(cfg.binaries.opencode, '/usr/bin/opencode');
  assert.deepEqual(cfg.models.opencode, ['opencode-go/gpt-5.6-luna', 'opencode-go/claude-haiku-5-5']);

  const registry = new DriverRegistry(cfg, [createOpencodeDriver(cfg)]);
  const resolved = registry.resolve('opencode/opencode-go/gpt-5.6-luna');
  assert.equal(resolved.driver.id, 'opencode');
  assert.equal(resolved.model, 'opencode-go/gpt-5.6-luna');
  assert.equal(resolved.qualifiedModel, 'opencode/opencode-go/gpt-5.6-luna');
  assert.equal(assertSafeModelName(resolved.model), 'opencode-go/gpt-5.6-luna');

  const listed = registry.listModels().map((m) => m.id);
  assert.deepEqual(listed, [
    'opencode/opencode-go/gpt-5.6-luna',
    'opencode/opencode-go/claude-haiku-5-5',
  ]);

  const ac = new AbortController();
  let captured;
  let seenPromptPath;
  const systemPrompt = 'PentAGI verbatim system prompt';
  const runner = async (opts) => {
    captured = opts;
    const agentConfig = JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT);
    const promptRef = agentConfig.agent.pentagi.prompt;
    assert.match(promptRef, /^\{file:.+\}$/);
    seenPromptPath = promptRef.slice('{file:'.length, -1);
    assert.equal(readFileSync(seenPromptPath, 'utf8'), systemPrompt);
    assert.equal(statSync(seenPromptPath).mode & 0o777, 0o600);
    return {
      stdout: [
        'not-json preamble',
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hel' } }),
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'lo ' } }),
        JSON.stringify({
          type: 'step_finish',
          part: {
            reason: 'stop',
            tokens: { input: 4, output: 9, reasoning: 3, cache: { read: 13217, write: 249 } },
          },
        }),
        JSON.stringify({
          type: 'step_finish',
          part: { reason: 'stop', tokens: { input: 1, output: 2, cache: { read: 3, write: 4 } } },
        }),
      ].join('\n'),
      stderr: '',
      code: 0,
    };
  };

  const out = await createOpencodeDriver(cfg, runner).invoke({
    model: resolved.model,
    prompt: 'Reply with ONLY OK',
    systemPrompt,
    userPrompt: 'call the tool',
    signal: ac.signal,
  });

  assert.equal(captured.binary, '/usr/bin/opencode');
  assert.deepEqual(captured.args, [
    'run',
    '--standalone',
    '--format',
    'json',
    '--archived',
    '--agent',
    'pentagi',
    '--model',
    'opencode-go/gpt-5.6-luna',
  ]);
  assert.equal(captured.stdin, 'call the tool');
  assert.equal(captured.args.includes('Reply with ONLY OK'), false);
  assert.equal(captured.args.includes(systemPrompt), false);
  const agentConfig = JSON.parse(captured.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(agentConfig.agent.pentagi.mode, 'primary');
  assert.deepEqual(agentConfig.agent.pentagi.tools, { '*': false });
  assert.equal(captured.env.OPENCODE_CONFIG_CONTENT.includes(systemPrompt), false);
  assert.equal(existsSync(seenPromptPath), false);
  assert.equal(captured.cwd, '/work');
  assert.equal(captured.timeoutMs, 90_000);
  assert.equal(captured.killGraceMs, 1_500);
  assert.equal(captured.maxOutputBytes, 65_536);
  assert.equal(captured.signal, ac.signal);
  assert.equal(out.text, 'Hello ');
  // reasoning is not completion; prompt tokens are input + cache.read + cache.write, summed across steps.
  assert.equal(out.usage.prompt_tokens, 4 + 13217 + 249 + 1 + 3 + 4);
  assert.equal(out.usage.completion_tokens, 11);

  const defaults = createOpencodeDriver(loadConfig({ CLI_BRIDGE_ENABLED_DRIVERS: 'opencode' }));
  assert.equal(defaults.defaultModel, 'opencode-go/gpt-5.6-luna');
  assert.deepEqual(defaults.models, [
    'opencode-go/gpt-5.6-luna',
    'opencode-go/claude-haiku-5-5',
    'opencode-go/deepseek-v4-pro',
    'opencode-go/kimi-k3',
  ]);
  assert.equal(defaults.modelLimits.contextWindow, 200_000);
  assert.equal(defaults.modelLimits.maxOutputTokens, 32_768);

  let plainOpts;
  const plain = await createOpencodeDriver(cfg, async (opts) => {
    plainOpts = opts;
    return { stdout: '  plain fallback  \n', stderr: '', code: 0 };
  }).invoke({
    model: 'opencode-go/claude-haiku-5-5',
    prompt: 'hi',
  });
  assert.equal(plain.text, 'plain fallback');
  assert.equal(plain.usage, undefined);
  assert.equal(plainOpts.stdin, 'hi');
  assert.equal(plainOpts.args.includes('--standalone'), true);
  assert.equal(plainOpts.args.includes('pentagi'), true);
  assert.deepEqual(JSON.parse(plainOpts.env.OPENCODE_CONFIG_CONTENT).agent.pentagi.tools, { '*': false });

  let thrownPath;
  await assert.rejects(
    () =>
      createOpencodeDriver(cfg, async (opts) => {
        const ref = JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT).agent.pentagi.prompt;
        thrownPath = ref.slice('{file:'.length, -1);
        assert.equal(existsSync(thrownPath), true);
        throw new Error('runner failed');
      }).invoke({
        model: 'opencode-go/claude-haiku-5-5',
        prompt: 'hi',
        systemPrompt: 'cleanup-me',
        userPrompt: 'turn',
      }),
    /runner failed/
  );
  assert.equal(existsSync(thrownPath), false);
});

test('runSubprocess enforces timeout, AbortSignal cancellation, output limit, and missing binary errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-proc-'));
  try {
    const sleeper = makeFakeBinary(dir, 'sleeper', `setTimeout(() => process.stdout.write('late'), 10000);`);
    const flooder = makeFakeBinary(dir, 'flooder', `process.stdout.write('A'.repeat(20000));`);

    await assert.rejects(
      () => runSubprocess({ binary: '/nonexistent/cli-binary-xyz', timeoutMs: 1000 }),
      (err) => err instanceof BridgeError && err.code === 'cli_not_found' && err.status === 503
    );

    await assert.rejects(
      () => runSubprocess({ binary: sleeper, timeoutMs: 250, killGraceMs: 100 }),
      (err) => err instanceof BridgeError && err.code === 'cli_timeout' && err.status === 504
    );

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    await assert.rejects(
      () => runSubprocess({ binary: sleeper, timeoutMs: 5000, killGraceMs: 100, signal: ac.signal }),
      (err) => err instanceof BridgeError && err.code === 'request_cancelled' && err.status === 499
    );

    await assert.rejects(
      () => runSubprocess({ binary: flooder, maxOutputBytes: 4096, timeoutMs: 3000 }),
      (err) => err instanceof BridgeError && err.code === 'cli_output_limit' && err.status === 502
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
