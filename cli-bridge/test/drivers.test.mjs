import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { BridgeError, DriverRegistry, assertSafeModelName, runSubprocess } from '../src/drivers/base.mjs';
import { createClaudeDriver } from '../src/drivers/claude.mjs';
import { createCodexDriver } from '../src/drivers/codex.mjs';
import { createGeminiDriver } from '../src/drivers/gemini.mjs';
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

  const models = registry.listModels().map((m) => m.id);
  assert.deepEqual(models, ['claude/sonnet', 'claude/opus']);

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
      const args = process.argv.slice(2);
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const hasDisabledTools = args.includes('--tools') && args[args.indexOf('--tools') + 1] === '';
        if (!hasDisabledTools) process.exit(42);
        process.stdout.write(JSON.stringify({
          type: 'result',
          result: JSON.stringify({ content: null, tool_calls: [{ name: 'done', arguments: { result: 'from-claude' } }] }),
          usage: { input_tokens: 15, output_tokens: 8 }
        }));
      });
      `
    );

    const fakeCodex = makeFakeBinary(
      dir,
      'fake-codex',
      `
      const args = process.argv.slice(2);
      if (!args.includes('read-only') || !args.includes('--skip-git-repo-check')) process.exit(43);
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

    const claudeRes = await createClaudeDriver(cfg).invoke({ model: 'sonnet', prompt: 'hello' });
    assert.match(claudeRes.text, /from-claude/);
    assert.equal(claudeRes.usage.prompt_tokens, 15);

    const codexRes = await createCodexDriver(cfg).invoke({ model: 'gpt-5', prompt: 'hello' });
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
