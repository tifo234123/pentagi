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
    async invoke({ model, prompt, signal }) {
      // Prompt is stdin-only so it never lands in argv. --archived keeps bridge turns out of
      // the user's session list. --agent plan is read-only so OpenCode cannot mutate host
      // files outside PentAGI's sandbox.
      const args = ['run', '--format', 'json', '--archived', '--agent', 'plan', '--model', model];

      const { stdout } = await runner({
        binary: config.binaries.opencode,
        args,
        stdin: prompt,
        cwd: config.workDir,
        timeoutMs: config.timeoutMs,
        killGraceMs: config.killGraceMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });

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
