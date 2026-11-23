import { BridgeError, runSubprocess } from './base.mjs';

const DEFAULT_MODELS = ['default'];

/**
 * Generic JSON-over-stdio driver inspired by T3 Code's ACP/CLI bridge contract.
 * Sends a single JSON request on stdin and parses a JSON response on stdout:
 *   stdin:  { protocol: "pentagi-cli-bridge/v1", model, prompt, messages, tools, tool_choice, response_format }
 *   stdout: { content?: string|null, text?: string, tool_calls?: [{ name, arguments }], usage?: { prompt_tokens, completion_tokens } }
 */
export function createStdioJsonDriver(config, runner = runSubprocess) {
  const models = config.models['stdio-json'].length > 0 ? config.models['stdio-json'] : DEFAULT_MODELS;

  return {
    id: 'stdio-json',
    defaultModel: models[0],
    models,
    async invoke({ model, prompt, messages, tools, toolChoice, responseFormat, signal }) {
      const binary = config.binaries['stdio-json'];
      if (!binary) {
        throw new BridgeError(
          'CLI_BRIDGE_STDIO_JSON_BIN must be set to use the stdio-json driver',
          { status: 503, code: 'driver_unconfigured', type: 'service_unavailable' }
        );
      }

      const stdin = JSON.stringify({
        protocol: 'pentagi-cli-bridge/v1',
        model,
        prompt,
        messages,
        tools,
        tool_choice: toolChoice,
        response_format: responseFormat,
      });

      const { stdout } = await runner({
        binary,
        args: [],
        stdin,
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
        throw new BridgeError('stdio-json driver returned malformed JSON output', {
          status: 502,
          code: 'malformed_cli_output',
          type: 'server_error',
        });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BridgeError('stdio-json driver response must be a JSON object', {
          status: 502,
          code: 'malformed_cli_output',
          type: 'server_error',
        });
      }

      const result = {
        usage: parsed.usage,
      };
      if ('content' in parsed) {
        result.content = parsed.content;
      }
      if (Array.isArray(parsed.tool_calls)) {
        result.tool_calls = parsed.tool_calls;
      }
      if (typeof parsed.text === 'string') {
        result.text = parsed.text;
      }
      return result;
    },
  };
}
