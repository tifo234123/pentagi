import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeError, runSubprocess } from './base.mjs';

const DEFAULT_MODELS = [
  'opencode-go/gpt-5.6-luna',
  'opencode-go/claude-haiku-5-5',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/kimi-k3',
];

function finiteInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function errorDetail(event) {
  if (typeof event.error?.message === 'string' && event.error.message) return event.error.message;
  if (typeof event.error === 'string' && event.error) return event.error;
  if (typeof event.message === 'string' && event.message) return event.message;
  return 'opencode run failed';
}

export function createOpencodeDriver(config, runner = runSubprocess) {
  const configured = config.models?.opencode;
  const models = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_MODELS;

  return {
    id: 'opencode',
    defaultModel: models[0],
    models,
    modelLimits: {
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
    },
    async invoke({ model, prompt, systemPrompt, userPrompt, signal }) {
      // OpenCode's built-in `plan` agent injects a ~25k-token coding-assistant prompt that
      // overrides PentAGI and disables tool-call JSON. A standalone primary agent with every
      // host tool disabled replaces that prompt. `{file:}` (verified on opencode v2.3.2) keeps
      // the system prompt out of argv and out of the child environment, which is world-readable
      // via /proc/<pid>/environ and capped by MAX_ARG_STRLEN.
      const args = ['run', '--standalone', '--format', 'json', '--archived', '--agent', 'pentagi', '--model', model];

      const deliverSystem = typeof systemPrompt === 'string' && systemPrompt.trim().length > 0;
      let promptFile = null;
      let agentPrompt = 'Follow the user message. Do not use host tools.';
      if (deliverSystem) {
        promptFile = join(tmpdir(), `cli-bridge-oc-${randomBytes(8).toString('hex')}.txt`);
        agentPrompt = `{file:${promptFile}}`;
      }

      const agentConfig = {
        permission: 'deny',
        agent: {
          pentagi: {
            description: 'PentAGI reasoning bridge',
            mode: 'primary',
            prompt: agentPrompt,
            tools: { '*': false },
            permission: { '*': 'deny' },
          },
        },
      };

      const stdinPayload =
        deliverSystem && typeof userPrompt === 'string' && userPrompt.trim() ? userPrompt : prompt;

      let stdout;
      try {
        if (promptFile) {
          writeFileSync(promptFile, systemPrompt, { encoding: 'utf8', mode: 0o600 });
        }
        ({ stdout } = await runner({
          binary: config.binaries.opencode,
          args,
          stdin: stdinPayload,
          cwd: config.workDir,
          env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(agentConfig) },
          timeoutMs: config.timeoutMs,
          killGraceMs: config.killGraceMs,
          maxOutputBytes: config.maxOutputBytes,
          signal,
        }));
      } finally {
        if (promptFile) {
          try {
            rmSync(promptFile, { force: true });
          } catch {
            // Best-effort temp cleanup.
          }
        }
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      let text = '';
      let sawJsonEvent = false;
      let usage;

      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        sawJsonEvent = true;

        if (event.type === 'error') {
          throw new BridgeError(`OpenCode CLI reported an error: ${errorDetail(event).slice(0, 500)}`, {
            status: 502,
            code: 'cli_driver_error',
            type: 'server_error',
          });
        }

        if (event.type === 'text' && typeof event.part?.text === 'string') {
          text += event.part.text;
        }

        if (event.type === 'step_finish' && event.part?.tokens && typeof event.part.tokens === 'object') {
          const tokens = event.part.tokens;
          const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
          const stepUsage = {
            prompt_tokens: finiteInt(tokens.input) + finiteInt(cache.read) + finiteInt(cache.write),
            completion_tokens: finiteInt(tokens.output),
          };
          if (usage) {
            usage = {
              prompt_tokens: usage.prompt_tokens + stepUsage.prompt_tokens,
              completion_tokens: usage.completion_tokens + stepUsage.completion_tokens,
            };
          } else {
            usage = stepUsage;
          }
        }
      }

      if (sawJsonEvent && !text) {
        throw new BridgeError('OpenCode CLI JSONL stream completed without text', {
          status: 502,
          code: 'malformed_cli_output',
          type: 'server_error',
        });
      }

      return {
        text: text || stdout.trim(),
        usage,
      };
    },
  };
}
