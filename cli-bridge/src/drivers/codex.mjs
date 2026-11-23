import { BridgeError, runSubprocess } from './base.mjs';

const DEFAULT_MODELS = ['gpt-5', 'gpt-5-mini', 'o4-mini'];

function finiteInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function createCodexDriver(config, runner = runSubprocess) {
  const models = config.models.codex.length > 0 ? config.models.codex : DEFAULT_MODELS;

  return {
    id: 'codex',
    defaultModel: models[0],
    models,
    async invoke({ model, prompt, signal }) {
      // --sandbox read-only blocks filesystem writes; --skip-git-repo-check lets codex
      // run inside the empty /work tmpfs container without requiring a git repository.
      const args = [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--json',
        '--model',
        model,
        '-',
      ];

      const { stdout } = await runner({
        binary: config.binaries.codex,
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

      let lastAgentMessage = '';
      let sawJsonEvent = false;
      let usage;

      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || typeof event !== 'object') continue;
        sawJsonEvent = true;

        if (event.type === 'error' || event.type === 'turn.failed') {
          const detail =
            (typeof event.message === 'string' && event.message) ||
            (typeof event.error?.message === 'string' && event.error.message) ||
            'codex turn failed';
          throw new BridgeError(`Codex CLI reported an error: ${detail.slice(0, 500)}`, {
            status: 502,
            code: 'cli_driver_error',
            type: 'server_error',
          });
        }

        if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          lastAgentMessage = event.item.text;
        } else if (event.type === 'response.completed' && typeof event.result === 'string') {
          lastAgentMessage = event.result;
        }

        if (event.usage && typeof event.usage === 'object') {
          usage = {
            prompt_tokens: finiteInt(event.usage.input_tokens ?? event.usage.prompt_tokens),
            completion_tokens: finiteInt(event.usage.output_tokens ?? event.usage.completion_tokens),
          };
        }
      }

      if (sawJsonEvent && !lastAgentMessage) {
        throw new BridgeError('Codex CLI JSONL stream completed without an agent_message', {
          status: 502,
          code: 'malformed_cli_output',
          type: 'server_error',
        });
      }

      return {
        text: lastAgentMessage || stdout.trim(),
        usage,
      };
    },
  };
}
