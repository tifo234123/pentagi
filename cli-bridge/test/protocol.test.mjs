import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBridgePrompt,
  createCallIdGenerator,
  formatCompletionResponse,
  parseCliModelOutput,
  validateChatRequest,
} from '../src/protocol.mjs';
import { createRedactor } from '../src/redactor.mjs';

const SAMPLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: 'Run command inside PentAGI sandbox',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Complete current subtask',
      parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
    },
  },
];

test('validateChatRequest rejects malformed payloads and accepts valid OpenAI chat requests', () => {
  assert.equal(validateChatRequest(null).ok, false);
  assert.equal(validateChatRequest([]).ok, false);
  assert.equal(validateChatRequest({ messages: [] }).ok, false);
  assert.equal(validateChatRequest({ messages: [{ role: '' }] }).ok, false);
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: 'hi' }], tools: 'bad' }).ok, false);

  const ok = validateChatRequest({
    model: 'claude/sonnet',
    messages: [{ role: 'user', content: 'check status' }],
    tools: SAMPLE_TOOLS,
    stream: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.model, 'claude/sonnet');
  assert.equal(ok.tools.length, 2);
  assert.equal(ok.stream, true);
});

test('buildBridgePrompt embeds PentAGI non-bypass rule, tool schemas, and transcript', () => {
  const prompt = buildBridgePrompt({
    messages: [
      { role: 'system', content: 'You are PentAGI primary agent.' },
      { role: 'user', content: 'Inspect /work' },
    ],
    tools: SAMPLE_TOOLS,
    toolChoice: 'required',
  });

  assert.match(prompt, /Do NOT execute shell commands/i);
  assert.match(prompt, /"name": "terminal"/);
  assert.match(prompt, /"name": "done"/);
  assert.match(prompt, /MUST return at least one valid tool call/);
  assert.match(prompt, /\[SYSTEM\]/);
  assert.match(prompt, /Inspect \/work/);
});

test('parseCliModelOutput extracts raw JSON, fenced JSON, and prose-embedded tool calls with fixed-width IDs', () => {
  const nextId = createCallIdGenerator();

  const raw = parseCliModelOutput(
    JSON.stringify({
      content: null,
      tool_calls: [{ name: 'terminal', arguments: { command: 'ls -la' } }],
    }),
    SAMPLE_TOOLS,
    nextId
  );
  assert.equal(raw.finishReason, 'tool_calls');
  assert.equal(raw.content, null);
  assert.equal(raw.toolCalls.length, 1);
  assert.equal(raw.toolCalls[0].id, 'call_000001');
  assert.equal(raw.toolCalls[0].function.name, 'terminal');
  assert.equal(raw.toolCalls[0].function.arguments, '{"command":"ls -la"}');

  const fenced = parseCliModelOutput(
    'Here is the call:\n```json\n{"content":"checking","tool_calls":[{"name":"done","arguments":{"result":"ok"}}]}\n```',
    SAMPLE_TOOLS,
    nextId
  );
  assert.equal(fenced.finishReason, 'tool_calls');
  assert.equal(fenced.content, 'checking');
  assert.equal(fenced.toolCalls[0].id, 'call_000002');
  assert.equal(fenced.toolCalls[0].function.name, 'done');

  const embedded = parseCliModelOutput(
    'Thinking briefly... {"content": null, "tool_calls": [{"name": "terminal", "arguments": "{\\"command\\":\\"pwd\\"}"}]} done.',
    SAMPLE_TOOLS,
    nextId
  );
  assert.equal(embedded.finishReason, 'tool_calls');
  assert.equal(embedded.toolCalls[0].id, 'call_000003');
  assert.equal(embedded.toolCalls[0].function.arguments, '{"command":"pwd"}');
});

test('parseCliModelOutput rejects unknown hallucinated tools and falls back cleanly to stop', () => {
  const nextId = createCallIdGenerator();
  const parsed = parseCliModelOutput(
    JSON.stringify({
      content: 'Falling back safely',
      tool_calls: [{ name: 'not_a_pentagi_tool', arguments: { x: 1 } }],
    }),
    SAMPLE_TOOLS,
    nextId
  );
  assert.equal(parsed.finishReason, 'stop');
  assert.equal(parsed.toolCalls.length, 0);
  assert.equal(parsed.content, 'Falling back safely');

  const malformed = parseCliModelOutput('Plain assistant answer with no JSON', SAMPLE_TOOLS, nextId);
  assert.equal(malformed.finishReason, 'stop');
  assert.equal(malformed.content, 'Plain assistant answer with no JSON');
});

test('formatCompletionResponse matches OpenAI chat.completion wire shape', () => {
  const parsed = parseCliModelOutput(
    { content: null, tool_calls: [{ name: 'done', arguments: { result: 'finished' } }] },
    SAMPLE_TOOLS,
    createCallIdGenerator()
  );
  const resp = formatCompletionResponse({
    id: 'chatcmpl-1',
    created: 1767225600,
    model: 'claude/sonnet',
    parsed,
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  });

  assert.equal(resp.object, 'chat.completion');
  assert.equal(resp.choices[0].finish_reason, 'tool_calls');
  assert.equal(resp.choices[0].message.tool_calls[0].id, 'call_000001');
  assert.equal(resp.usage.total_tokens, 17);
});

test('createRedactor scrubs secrets verbatim longest-first across nested objects', () => {
  const redactor = createRedactor(['sk-secret', 'sk-secret-super-long-token']);
  const scrubbed = redactor.redact({
    error: 'failed with sk-secret-super-long-token and sk-secret',
    nested: ['token=sk-secret-super-long-token'],
  });
  assert.equal(scrubbed.error, 'failed with [REDACTED] and [REDACTED]');
  assert.equal(scrubbed.nested[0], 'token=[REDACTED]');
});
