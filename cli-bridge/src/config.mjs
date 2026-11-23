const KNOWN_DRIVERS = new Set(['claude', 'codex', 'gemini', 'stdio-json']);

function parsePositiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid numeric configuration value "${raw}" (expected ${min}..${max})`);
  }
  return value;
}

function parseCsvList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Load and validate bridge configuration from environment variables.
 * Security defaults:
 * - No drivers enabled unless explicitly allowlisted via CLI_BRIDGE_ENABLED_DRIVERS.
 * - API key is mandatory for non-test startup so /v1/* is never exposed unauthenticated.
 */
export function loadConfig(env = process.env) {
  const host = (env.CLI_BRIDGE_HOST || '0.0.0.0').trim();
  const port = parsePositiveInt(env.CLI_BRIDGE_PORT, 8090, { min: 0, max: 65535 });
  const apiKey = (env.CLI_BRIDGE_API_KEY || '').trim();

  const enabledDrivers = parseCsvList(env.CLI_BRIDGE_ENABLED_DRIVERS).map((d) => d.toLowerCase());
  for (const driver of enabledDrivers) {
    if (!KNOWN_DRIVERS.has(driver)) {
      throw new Error(
        `Unknown driver "${driver}" in CLI_BRIDGE_ENABLED_DRIVERS (allowed: ${[...KNOWN_DRIVERS].join(', ')})`
      );
    }
  }

  const defaultDriver = (env.CLI_BRIDGE_DEFAULT_DRIVER || '').trim().toLowerCase();
  if (defaultDriver && !KNOWN_DRIVERS.has(defaultDriver)) {
    throw new Error(
      `Unknown CLI_BRIDGE_DEFAULT_DRIVER "${defaultDriver}" (allowed: ${[...KNOWN_DRIVERS].join(', ')})`
    );
  }
  if (defaultDriver && !enabledDrivers.includes(defaultDriver)) {
    throw new Error(
      `CLI_BRIDGE_DEFAULT_DRIVER "${defaultDriver}" must also be listed in CLI_BRIDGE_ENABLED_DRIVERS`
    );
  }

  const timeoutMs = parsePositiveInt(env.CLI_BRIDGE_TIMEOUT_MS, 120_000, {
    min: 200,
    max: 600_000,
  });
  const killGraceMs = parsePositiveInt(env.CLI_BRIDGE_KILL_GRACE_MS, 2_000, {
    min: 50,
    max: 30_000,
  });
  const maxOutputBytes = parsePositiveInt(env.CLI_BRIDGE_MAX_OUTPUT_BYTES, 1_048_576, {
    min: 4_096,
    max: 16_777_216,
  });
  const maxRequestBytes = parsePositiveInt(env.CLI_BRIDGE_MAX_REQUEST_BYTES, 2_097_152, {
    min: 4_096,
    max: 33_554_432,
  });
  const maxConcurrent = parsePositiveInt(env.CLI_BRIDGE_MAX_CONCURRENT, 8, {
    min: 1,
    max: 64,
  });

  const binaries = {
    claude: (env.CLI_BRIDGE_CLAUDE_BIN || 'claude').trim(),
    codex: (env.CLI_BRIDGE_CODEX_BIN || 'codex').trim(),
    gemini: (env.CLI_BRIDGE_GEMINI_BIN || 'gemini').trim(),
    'stdio-json': (env.CLI_BRIDGE_STDIO_JSON_BIN || '').trim(),
  };

  const models = {
    claude: parseCsvList(env.CLI_BRIDGE_CLAUDE_MODELS),
    codex: parseCsvList(env.CLI_BRIDGE_CODEX_MODELS),
    gemini: parseCsvList(env.CLI_BRIDGE_GEMINI_MODELS),
    'stdio-json': parseCsvList(env.CLI_BRIDGE_STDIO_JSON_MODELS),
  };

  const redactValues = [
    ...(apiKey ? [apiKey] : []),
    ...parseCsvList(env.CLI_BRIDGE_REDACT_VALUES),
  ];

  return {
    host,
    port,
    apiKey,
    enabledDrivers: [...new Set(enabledDrivers)],
    defaultDriver,
    timeoutMs,
    killGraceMs,
    maxOutputBytes,
    maxRequestBytes,
    maxConcurrent,
    binaries,
    models,
    workDir: (env.CLI_BRIDGE_WORK_DIR || process.cwd()).trim(),
    redactValues,
  };
}

export { KNOWN_DRIVERS };
