import { extractJsonObject } from '../protocol.mjs';
import { BridgeError, runSubprocess } from './base.mjs';

const DEFAULT_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];

function finiteInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function extractGeminiUsage(parsed, model) {
  const modelsStats = parsed?.stats?.models;
  if (!modelsStats || typeof modelsStats !== 'object') return undefined;

  const exact = modelsStats[model]?.tokens;
  if (exact && typeof exact === 'object') {
    return {
      prompt_tokens: finiteInt(exact.prompt ?? exact.input),
      completion_tokens: finiteInt(exact.candidates ?? exact.output),
    };
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let found = false;
  for (const entry of Object.values(modelsStats)) {
    if (entry?.tokens && typeof entry.tokens === 'object') {
      promptTokens += finiteInt(entry.tokens.prompt ?? entry.tokens.input);
      completionTokens += finiteInt(entry.tokens.candidates ?? entry.tokens.output);
      found = true;
    }
  }
  return found ? { prompt_tokens: promptTokens, completion_tokens: completionTokens } : undefined;
}

export function createGeminiDriver(config, runner = runSubprocess) {
  const models = config.models.gemini.length > 0 ? config.models.gemini : DEFAULT_MODELS;

  return {
    id: 'gemini',
    defaultModel: models[0],
    models,
    modelLimits: {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
    },
    async invoke({ model, prompt, signal }) {
      // Prompt supplied on stdin. --approval-mode plan restricts Gemini CLI to read-only
      // planning mode so host mutations cannot occur outside PentAGI's Docker sandbox.
      const args = ['-p', '', '--approval-mode', 'plan', '--output-format', 'json', '--model', model];

      const { stdout } = await runner({
        binary: config.binaries.gemini,
        args,
        stdin: prompt,
        cwd: config.workDir,
        timeoutMs: config.timeoutMs,
        killGraceMs: config.killGraceMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });

      const trimmed = stdout.trim();
      const parsed = extractJsonObject(
        trimmed,
        (obj) => 'response' in obj || 'error' in obj || 'stats' in obj
      );

      if (parsed && typeof parsed === 'object') {
        if (parsed.error) {
          const detail =
            typeof parsed.error === 'string'
              ? parsed.error
              : typeof parsed.error?.message === 'string'
                ? parsed.error.message
                : JSON.stringify(parsed.error);
          throw new BridgeError(`Gemini CLI reported an error: ${detail.slice(0, 500)}`, {
            status: 502,
            code: 'cli_driver_error',
            type: 'server_error',
          });
        }
        const text =
          typeof parsed.response === 'string'
            ? parsed.response
            : typeof parsed.text === 'string'
              ? parsed.text
              : trimmed;
        return { text, usage: extractGeminiUsage(parsed, model) };
      }

      return { text: trimmed };
    },
  };
}
