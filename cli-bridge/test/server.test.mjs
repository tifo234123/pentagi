import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { createBridgeApp } from '../src/server.mjs';

function makeFakeBinary(dir, name, jsBody) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${jsBody}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

async function startTestServer(envOverrides) {
  const cfg = loadConfig({
    CLI_BRIDGE_PORT: '0',
    CLI_BRIDGE_API_KEY: 'super-secret-bridge-token',
    ...envOverrides,
  });
  const silentLogger = { error() {}, log() {} };
  const app = createBridgeApp(cfg, { logger: silentLogger });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: cfg.apiKey,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

test('HTTP bridge enforces Bearer auth, lists enabled models, and serves plain & SSE tool completions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-http-'));
  const fakeClaude = makeFakeBinary(
    dir,
    'fake-claude',
    `
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const prompt = Buffer.concat(chunks).toString('utf8');
      if (prompt.includes('TRIGGER_SECRET_LEAK')) {
        process.stderr.write('upstream failure using super-secret-bridge-token and extra-secret-9999');
        process.exit(1);
      }
      if (prompt.includes('TRIGGER_TOOL')) {
        process.stdout.write(JSON.stringify({
          result: JSON.stringify({
            content: null,
            tool_calls: [{ name: 'done', arguments: { result: 'subtask completed under pentagi rules' } }]
          }),
          usage: { input_tokens: 40, output_tokens: 12 }
        }));
        return;
      }
      process.stdout.write(JSON.stringify({
        result: 'Assistant answer streamed safely through PentAGI.',
        usage: { input_tokens: 18, output_tokens: 7 }
      }));
    });
    `
  );

  const srv = await startTestServer({
    CLI_BRIDGE_ENABLED_DRIVERS: 'claude',
    CLI_BRIDGE_CLAUDE_BIN: fakeClaude,
    CLI_BRIDGE_CLAUDE_MODELS: 'sonnet',
    CLI_BRIDGE_REDACT_VALUES: 'extra-secret-9999',
    CLI_BRIDGE_MAX_CONCURRENT: '2',
  });

  try {
    // 1. Healthz is open and does not leak secrets
    const healthRes = await fetch(`${srv.baseUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.deepEqual(health.enabled_drivers, ['claude']);

    // 2. Auth rejected when missing or wrong token
    const noAuth = await fetch(`${srv.baseUrl}/v1/models`);
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${srv.baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    assert.equal(badAuth.status, 401);

    // 3. /v1/models returns enabled models only
    const modelsRes = await fetch(`${srv.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${srv.apiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsBody = await modelsRes.json();
    assert.deepEqual(
      modelsBody.data.map((m) => m.id),
      ['claude/sonnet']
    );

    // 4. Non-streaming tool call completion matches PentAGI wire format
    const toolRes = await fetch(`${srv.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude/sonnet',
        messages: [{ role: 'user', content: 'TRIGGER_TOOL' }],
        tools: [
          {
            type: 'function',
            function: { name: 'done', description: 'finish', parameters: { type: 'object' } },
          },
        ],
      }),
    });
    assert.equal(toolRes.status, 200);
    const toolJson = await toolRes.json();
    assert.equal(toolJson.choices[0].finish_reason, 'tool_calls');
    assert.match(toolJson.choices[0].message.tool_calls[0].id, /^call_[0-9a-f]{24}$/);
    assert.equal(toolJson.choices[0].message.tool_calls[0].function.name, 'done');
    assert.equal(toolJson.usage.total_tokens, 52);

    // 5. Streaming SSE completion emits OpenAI chunks + [DONE]
    const sseRes = await fetch(`${srv.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude/sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'Summarize findings' }],
      }),
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
    const sseText = await sseRes.text();
    assert.match(sseText, /"object":"chat\.completion\.chunk"/);
    assert.match(sseText, /Assistant answer streamed safely through PentAGI/);
    assert.match(sseText, /data: \[DONE\]/);

    // 6. Secret redaction scrubs API key and configured secrets from error envelopes
    const errRes = await fetch(`${srv.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude/sonnet',
        messages: [{ role: 'user', content: 'TRIGGER_SECRET_LEAK' }],
      }),
    });
    assert.equal(errRes.status, 502);
    const errJson = await errRes.json();
    assert.doesNotMatch(errJson.error.message, /super-secret-bridge-token/);
    assert.doesNotMatch(errJson.error.message, /extra-secret-9999/);
    assert.match(errJson.error.message, /\[REDACTED\]/);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP bridge returns 429 when concurrency cap is saturated and cancels CLI on client abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-conc-'));
  const slowCli = makeFakeBinary(
    dir,
    'slow-claude',
    `
    process.stdin.resume();
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ result: 'slow-ok' }));
    }, 600);
    `
  );

  const srv = await startTestServer({
    CLI_BRIDGE_ENABLED_DRIVERS: 'claude',
    CLI_BRIDGE_CLAUDE_BIN: slowCli,
    CLI_BRIDGE_MAX_CONCURRENT: '1',
    CLI_BRIDGE_KILL_GRACE_MS: '100',
  });

  try {
    const reqInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude/sonnet',
        messages: [{ role: 'user', content: 'wait' }],
      }),
    };

    const ac = new AbortController();
    const firstPromise = fetch(`${srv.baseUrl}/v1/chat/completions`, { ...reqInit, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 80));

    // Second concurrent request must receive 429 so PentAGI's retry loop backs off cleanly
    const secondRes = await fetch(`${srv.baseUrl}/v1/chat/completions`, reqInit);
    assert.equal(secondRes.status, 429);
    const secondJson = await secondRes.json();
    assert.equal(secondJson.error.code, 'concurrency_limit');

    // Aborting first request should cancel the subprocess and release the slot quickly
    ac.abort();
    await assert.rejects(() => firstPromise);
    await new Promise((r) => setTimeout(r, 150));

    const health = await (await fetch(`${srv.baseUrl}/healthz`)).json();
    assert.equal(health.active_requests, 0);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
