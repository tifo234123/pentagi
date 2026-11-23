import { spawn } from 'node:child_process';

const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export class BridgeError extends Error {
  constructor(message, { status = 502, code = 'bridge_error', type = 'server_error' } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export function assertSafeModelName(model) {
  if (!model || !SAFE_MODEL_RE.test(model)) {
    throw new BridgeError(
      `Invalid model identifier "${model}": must match ${SAFE_MODEL_RE.source} and cannot start with "-"`,
      { status: 400, code: 'invalid_model', type: 'invalid_request_error' }
    );
  }
  return model;
}

/**
 * Strip bridge-internal secrets (CLI_BRIDGE_*) so spawned external CLIs never
 * inherit the gateway's Bearer API key or configured redaction secrets.
 */
export function buildSafeChildEnv(baseEnv = process.env) {
  const clean = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (k.startsWith('CLI_BRIDGE_')) continue;
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

function signalProcessGroup(child, sig) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // Fallback to direct child signal if process group already gone.
    }
  }
  try {
    child.kill(sig);
  } catch {
    // Process already exited.
  }
}

/**
 * Execute an allowlisted CLI binary strictly without a shell (`shell: false`),
 * enforcing stripped bridge env, bounded stdout/stderr, hard timeouts, and
 * process-group SIGTERM -> SIGKILL cancellation so grandchildren cannot leak.
 */
export function runSubprocess({
  binary,
  args = [],
  stdin = '',
  cwd = process.cwd(),
  env,
  timeoutMs = 120_000,
  killGraceMs = 2_000,
  maxOutputBytes = 1_048_576,
  signal,
}) {
  return new Promise((resolve, reject) => {
    if (!binary || typeof binary !== 'string') {
      reject(
        new BridgeError('CLI driver binary path is not configured', {
          status: 503,
          code: 'driver_unconfigured',
          type: 'service_unavailable',
        })
      );
      return;
    }

    if (signal?.aborted) {
      reject(
        new BridgeError('Request cancelled before CLI subprocess started', {
          status: 499,
          code: 'request_cancelled',
          type: 'cancelled_error',
        })
      );
      return;
    }

    const child = spawn(binary, args, {
      cwd,
      env: buildSafeChildEnv(env ?? process.env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer = null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const isAlive = () => child.exitCode === null && child.signalCode === null;

    const terminateChild = () => {
      if (!isAlive()) return;
      signalProcessGroup(child, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (isAlive()) {
            signalProcessGroup(child, 'SIGKILL');
          }
        }, killGraceMs);
        killTimer.unref?.();
      }
    };

    const onAbort = () => {
      cancelled = true;
      terminateChild();
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (outputExceeded) return;
      if (stdoutBytes + chunk.length > maxOutputBytes) {
        outputExceeded = true;
        terminateChild();
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      const cap = Math.min(maxOutputBytes, 65_536);
      if (stderrBytes >= cap) return;
      const slice = chunk.subarray(0, cap - stderrBytes);
      stderrBytes += slice.length;
      stderrChunks.push(slice);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === 'ENOENT') {
        reject(
          new BridgeError(`CLI binary "${binary}" was not found on PATH`, {
            status: 503,
            code: 'cli_not_found',
            type: 'service_unavailable',
          })
        );
        return;
      }
      reject(
        new BridgeError(`Failed to spawn CLI binary "${binary}": ${err.message}`, {
          status: 502,
          code: 'cli_spawn_error',
          type: 'server_error',
        })
      );
    });

    child.on('close', (code, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (cancelled) {
        reject(
          new BridgeError('CLI execution cancelled by caller', {
            status: 499,
            code: 'request_cancelled',
            type: 'cancelled_error',
          })
        );
        return;
      }
      if (timedOut) {
        reject(
          new BridgeError(`CLI execution timed out after ${timeoutMs}ms`, {
            status: 504,
            code: 'cli_timeout',
            type: 'timeout_error',
          })
        );
        return;
      }
      if (outputExceeded) {
        reject(
          new BridgeError(`CLI stdout exceeded maximum size limit (${maxOutputBytes} bytes)`, {
            status: 502,
            code: 'cli_output_limit',
            type: 'server_error',
          })
        );
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `signal ${exitSignal || 'unknown'}`;
        reject(
          new BridgeError(`CLI exited with status ${code}: ${detail.slice(0, 500)}`, {
            status: 502,
            code: 'cli_nonzero_exit',
            type: 'server_error',
          })
        );
        return;
      }

      resolve({ stdout, stderr, code });
    });

    child.stdin.on('error', () => {
      // Child may exit before reading full stdin; handled in close/error events.
    });
    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

export class DriverRegistry {
  constructor(config, drivers) {
    this.config = config;
    this.drivers = new Map();
    for (const driver of drivers) {
      this.drivers.set(driver.id, driver);
    }
    this.enabledSet = new Set(config.enabledDrivers);
  }

  listEnabledDrivers() {
    return [...this.enabledSet]
      .map((id) => this.drivers.get(id))
      .filter(Boolean);
  }

  listModels() {
    const out = [];
    for (const driver of this.listEnabledDrivers()) {
      const limits = driver.modelLimits || {};
      for (const model of driver.models) {
        const entry = {
          id: `${driver.id}/${model}`,
          object: 'model',
          created: 1767225600,
          owned_by: `cli-bridge:${driver.id}`,
        };
        if (Number.isFinite(limits.contextWindow) && limits.contextWindow > 0) {
          entry.context_window = limits.contextWindow;
        }
        if (Number.isFinite(limits.maxOutputTokens) && limits.maxOutputTokens > 0) {
          entry.max_output_tokens = limits.maxOutputTokens;
        }
        out.push(entry);
      }
    }
    return out;
  }

  resolve(requestedModel) {
    if (this.enabledSet.size === 0) {
      throw new BridgeError(
        'No CLI drivers are enabled; set CLI_BRIDGE_ENABLED_DRIVERS explicitly',
        { status: 503, code: 'no_drivers_enabled', type: 'service_unavailable' }
      );
    }

    const raw = String(requestedModel || '').trim();
    let driverId = '';
    let model = '';

    const slashIdx = raw.indexOf('/');
    if (slashIdx > 0) {
      driverId = raw.slice(0, slashIdx).toLowerCase();
      model = raw.slice(slashIdx + 1).trim();
    } else if (this.config.defaultDriver) {
      driverId = this.config.defaultDriver;
      model = raw;
    } else {
      throw new BridgeError(
        `Model "${raw}" must be prefixed with "<driver>/<model>" or configure CLI_BRIDGE_DEFAULT_DRIVER`,
        { status: 400, code: 'ambiguous_model', type: 'invalid_request_error' }
      );
    }

    if (!this.drivers.has(driverId)) {
      throw new BridgeError(`Unknown CLI driver "${driverId}"`, {
        status: 400,
        code: 'unknown_driver',
        type: 'invalid_request_error',
      });
    }

    if (!this.enabledSet.has(driverId)) {
      throw new BridgeError(
        `CLI driver "${driverId}" is disabled; allowlist it in CLI_BRIDGE_ENABLED_DRIVERS`,
        { status: 403, code: 'driver_disabled', type: 'permission_error' }
      );
    }

    const driver = this.drivers.get(driverId);
    const resolvedModel = assertSafeModelName(model || driver.defaultModel);
    return { driver, model: resolvedModel, qualifiedModel: `${driver.id}/${resolvedModel}` };
  }
}
