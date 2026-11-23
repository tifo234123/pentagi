import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeError, runSubprocess } from './base.mjs';

const DEFAULT_MODELS = ['sonnet', 'opus', 'haiku'];

function finiteInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function createClaudeDriver(config, runner = runSubprocess) {
  const models = config.models.claude.length > 0 ? config.models.claude : DEFAULT_MODELS;

  return {
    id: 'claude',
    defaultModel: models[0],
    models,
    modelLimits: {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
    async invoke({ model, prompt, systemPrompt, userPrompt, jsonSchema, signal }) {
      // --tools "" disables built-in host tools; --strict-mcp-config + empty config and
      // --setting-sources "" block user/workspace MCP servers and hooks so every tool call
      // routes exclusively back through PentAGI's customExecutor and per-flow Docker sandbox.
      // --system-prompt-file replaces Claude Code's built-in coding persona with PentAGI's
      // exact system prompt, giving PentAGI true system-level instruction priority.
      const args = [
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--no-session-persistence',
        '--model',
        model,
      ];

      let systemPromptFile = null;
      let stdinPayload = prompt;
      if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
        systemPromptFile = join(tmpdir(), `cli-bridge-sys-${randomBytes(8).toString('hex')}.txt`);
        writeFileSync(systemPromptFile, systemPrompt, { encoding: 'utf8', mode: 0o600 });
        args.push('--system-prompt-file', systemPromptFile);
        stdinPayload = typeof userPrompt === 'string' && userPrompt.trim() ? userPrompt : prompt;
      }

      if (jsonSchema && typeof jsonSchema === 'object') {
        args.push('--json-schema', JSON.stringify(jsonSchema));
      }

      let stdout;
      try {
        ({ stdout } = await runner({
          binary: config.binaries.claude,
          args,
          stdin: stdinPayload,
          cwd: config.workDir,
          timeoutMs: config.timeoutMs,
          killGraceMs: config.killGraceMs,
          maxOutputBytes: config.maxOutputBytes,
          signal,
        }));
      } finally {
        if (systemPromptFile) {
          try {
            rmSync(systemPromptFile, { force: true });
          } catch {
            // Best-effort temp cleanup.
          }
        }
      }

      const trimmed = stdout.trim();
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { text: trimmed };
      }

      if (parsed && typeof parsed === 'object') {
        if (parsed.is_error === true) {
          throw new BridgeError(
            `Claude CLI reported an error: ${String(parsed.result || parsed.error || 'unknown error').slice(0, 500)}`,
            { status: 502, code: 'cli_driver_error', type: 'server_error' }
          );
        }
        const usage = parsed.usage
          ? {
              prompt_tokens:
                finiteInt(parsed.usage.input_tokens ?? parsed.usage.prompt_tokens) +
                finiteInt(parsed.usage.cache_read_input_tokens) +
                finiteInt(parsed.usage.cache_creation_input_tokens),
              completion_tokens: finiteInt(parsed.usage.output_tokens ?? parsed.usage.completion_tokens),
            }
          : undefined;

        if (parsed.structured_output && typeof parsed.structured_output === 'object' && !Array.isArray(parsed.structured_output)) {
          if ('tool_calls' in parsed.structured_output || 'content' in parsed.structured_output) {
            return {
              content: parsed.structured_output.content ?? null,
              tool_calls: Array.isArray(parsed.structured_output.tool_calls)
                ? parsed.structured_output.tool_calls
                : [],
              usage,
            };
          }
          return { text: JSON.stringify(parsed.structured_output), usage };
        }

        const text =
          typeof parsed.result === 'string'
            ? parsed.result
            : typeof parsed.content === 'string'
              ? parsed.content
              : trimmed;
        return { text, usage };
      }

      return { text: trimmed };
    },
  };
}
