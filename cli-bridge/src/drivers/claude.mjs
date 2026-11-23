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
    async invoke({ model, prompt, signal }) {
      // --tools "" disables built-in host tools; --strict-mcp-config + empty config and
      // --setting-sources "" block user/workspace MCP servers and hooks so every tool call
      // routes exclusively back through PentAGI's customExecutor and per-flow Docker sandbox.
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

      const { stdout } = await runner({
        binary: config.binaries.claude,
        args,
        stdin: prompt,
        cwd: config.workDir,
        timeoutMs: config.timeoutMs,
        killGraceMs: config.killGraceMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });

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
        const text =
          typeof parsed.result === 'string'
            ? parsed.result
            : typeof parsed.content === 'string'
              ? parsed.content
              : trimmed;
        const usage = parsed.usage
          ? {
              prompt_tokens: finiteInt(parsed.usage.input_tokens ?? parsed.usage.prompt_tokens),
              completion_tokens: finiteInt(parsed.usage.output_tokens ?? parsed.usage.completion_tokens),
            }
          : undefined;
        return { text, usage };
      }

      return { text: trimmed };
    },
  };
}
