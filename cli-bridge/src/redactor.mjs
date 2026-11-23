/**
 * Verbatim secret redactor mirroring PentAGI's Config.GetSecretPatterns() invariant.
 * Secrets are matched longest-first so shorter substrings cannot leave partial leaks.
 */
export function createRedactor(secrets = []) {
  const unique = [...new Set(secrets.map((s) => String(s || '').trim()).filter((s) => s.length >= 4))]
    .sort((a, b) => b.length - a.length);

  const escaped = unique.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.length > 0 ? new RegExp(escaped.join('|'), 'g') : null;

  function redact(input) {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') {
      return pattern ? input.replace(pattern, '[REDACTED]') : input;
    }
    if (Array.isArray(input)) {
      return input.map((item) => redact(item));
    }
    if (typeof input === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        out[k] = redact(v);
      }
      return out;
    }
    return input;
  }

  return {
    redact,
    count: unique.length,
  };
}
