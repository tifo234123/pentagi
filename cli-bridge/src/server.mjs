import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { createClaudeDriver } from './drivers/claude.mjs';
import { createCodexDriver } from './drivers/codex.mjs';
import { createGeminiDriver } from './drivers/gemini.mjs';
import { createOpencodeDriver } from './drivers/opencode.mjs';
import { createStdioJsonDriver } from './drivers/stdio-json.mjs';
import { BridgeError, DriverRegistry } from './drivers/base.mjs';
import {
  buildBridgePayload,
  createCallIdGenerator,
  formatCompletionResponse,
  formatOpenAiError,
  parseCliModelOutput,
  validateChatRequest,
  writeSseCompletion,
} from './protocol.mjs';
import { createRedactor } from './redactor.mjs';

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function isAuthorized(req, expectedKey) {
  if (!expectedKey) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length).trim();
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest(expectedKey));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err, destroyStream = false) => {
      if (settled) return;
      settled = true;
      if (destroyStream) {
        req.pause();
      }
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new BridgeError(`Request body exceeds ${maxBytes} bytes`, {
            status: 413,
            code: 'request_too_large',
            type: 'invalid_request_error',
          }),
          true
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (err) => {
      fail(
        new BridgeError(`Failed to read request body: ${err.message}`, {
          status: 400,
          code: 'read_error',
          type: 'invalid_request_error',
        })
      );
    });

    req.on('close', () => {
      if (!settled && !req.complete) {
        fail(
          new BridgeError('Client closed connection while sending request body', {
            status: 499,
            code: 'request_cancelled',
            type: 'cancelled_error',
          })
        );
      }
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (err) {
        reject(
          new BridgeError(`Invalid JSON request body: ${err.message}`, {
            status: 400,
            code: 'invalid_json',
            type: 'invalid_request_error',
          })
        );
      }
    });
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function redactJsonArguments(rawArgs, redactor) {
  try {
    const parsed = JSON.parse(rawArgs);
    return redactor.redact(JSON.stringify(redactor.redact(parsed)));
  } catch {
    return redactor.redact(rawArgs);
  }
}

function redactParsedOutput(parsed, redactor) {
  return {
    ...parsed,
    content: typeof parsed.content === 'string' ? redactor.redact(parsed.content) : parsed.content,
    toolCalls: parsed.toolCalls.map((tc) => ({
      ...tc,
      function: {
        ...tc.function,
        arguments: redactJsonArguments(tc.function.arguments, redactor),
      },
    })),
  };
}

export function createBridgeApp(config, { runner, logger = console } = {}) {
  const redactor = createRedactor(config.redactValues);
  const drivers = [
    createClaudeDriver(config, runner),
    createCodexDriver(config, runner),
    createGeminiDriver(config, runner),
    createOpencodeDriver(config, runner),
    createStdioJsonDriver(config, runner),
  ];
  const registry = new DriverRegistry(config, drivers);
  const nextCallId = createCallIdGenerator();
  const activeControllers = new Set();
  let completionCounter = 0;
  let activeRequests = 0;

  const sendError = (res, status, message, type = 'server_error', code = null, extraHeaders = {}) => {
    sendJson(res, status, formatOpenAiError(redactor.redact(message), type, code), extraHeaders);
  };

  const server = createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      let pathname;
      try {
        pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      } catch {
        sendError(res, 400, 'Malformed request URL', 'invalid_request_error', 'invalid_url');
        return;
      }

      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, {
          status: 'ok',
          enabled_drivers: registry.listEnabledDrivers().map((d) => d.id),
          active_requests: activeRequests,
          max_concurrent: config.maxConcurrent,
        });
        return;
      }

      const isModelsRoute = pathname === '/v1/models' || pathname === '/models';
      const isCompletionsRoute = pathname === '/v1/chat/completions' || pathname === '/chat/completions';

      // All API endpoints require Bearer auth (both /v1/* and unprefixed aliases used by custom gateways).
      if (pathname.startsWith('/v1/') || isModelsRoute || isCompletionsRoute) {
        if (!isAuthorized(req, config.apiKey)) {
          sendError(
            res,
            401,
            'Unauthorized: invalid or missing Bearer token',
            'authentication_error',
            'unauthorized'
          );
          return;
        }
      }

      if (method === 'GET' && isModelsRoute) {
        const models = registry.listModels();
        logger.log?.(`[cli-bridge] GET ${pathname} -> 200 (${models.length} models)`);
        sendJson(res, 200, {
          object: 'list',
          data: models,
        });
        return;
      }

      if (method === 'POST' && isCompletionsRoute) {
        // Reserve concurrency slot synchronously BEFORE any await to prevent TOCTOU bursts.
        if (activeRequests >= config.maxConcurrent) {
          sendError(
            res,
            429,
            `Bridge concurrency limit reached (${config.maxConcurrent} active requests); retry shortly`,
            'rate_limit_error',
            'concurrency_limit'
          );
          return;
        }

        activeRequests += 1;
        const abortController = new AbortController();
        activeControllers.add(abortController);
        const onResClose = () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        };
        res.on('close', onResClose);

        let qualifiedModel = '';
        const startedAt = Date.now();
        try {
          const rawBody = await readJsonBody(req, config.maxRequestBytes);

          const validated = validateChatRequest(rawBody);
          if (!validated.ok) {
            sendError(res, 400, validated.error, 'invalid_request_error', 'invalid_request');
            return;
          }

          const resolved = registry.resolve(validated.model);
          qualifiedModel = resolved.qualifiedModel;

          const payload = buildBridgePayload({
            messages: validated.messages,
            tools: validated.tools,
            toolChoice: validated.toolChoice,
            responseFormat: validated.responseFormat,
          });

          const driverOutput = await resolved.driver.invoke({
            model: resolved.model,
            prompt: payload.prompt,
            systemPrompt: payload.systemPrompt,
            userPrompt: payload.userPrompt,
            jsonSchema: payload.jsonSchema,
            strictJsonSchema: payload.strictJsonSchema,
            messages: validated.messages,
            tools: validated.tools,
            toolChoice: validated.toolChoice,
            responseFormat: validated.responseFormat,
            signal: abortController.signal,
          });

          if (res.writableEnded || res.destroyed || abortController.signal.aborted) {
            return;
          }

          const parsed = redactParsedOutput(
            parseCliModelOutput(driverOutput, validated.tools, nextCallId, {
              toolChoice: validated.toolChoice,
              responseFormat: validated.responseFormat,
            }),
            redactor
          );

          completionCounter += 1;
          const id = `chatcmpl-clibridge-${completionCounter}`;
          const created = Math.floor(Date.now() / 1000);
          const elapsedMs = Date.now() - startedAt;
          const promptTok = driverOutput?.usage?.prompt_tokens ?? 0;
          const compTok = driverOutput?.usage?.completion_tokens ?? 0;
          logger.log?.(
            `[cli-bridge] POST ${pathname} model=${resolved.qualifiedModel} stream=${validated.stream} finish=${parsed.finishReason} tools=${parsed.toolCalls.length} tokens=${promptTok}/${compTok} ms=${elapsedMs}`
          );

          if (validated.stream) {
            writeSseCompletion(res, {
              id,
              created,
              model: resolved.qualifiedModel,
              parsed,
              usage: driverOutput?.usage,
            });
          } else {
            sendJson(
              res,
              200,
              formatCompletionResponse({
                id,
                created,
                model: resolved.qualifiedModel,
                parsed,
                usage: driverOutput?.usage,
              })
            );
          }
        } catch (err) {
          if (res.writableEnded || res.destroyed) return;
          const status = err instanceof BridgeError ? err.status : 502;
          const type = err instanceof BridgeError ? err.type : 'server_error';
          const code = err instanceof BridgeError ? err.code : 'bridge_failure';
          const safeMessage = redactor.redact(err?.message || 'CLI driver invocation failed');
          if (status >= 500) {
            logger.error?.(`[cli-bridge] ${qualifiedModel || 'request'} failed (${status}/${code}): ${safeMessage}`);
          }
          const headers = status === 413 ? { connection: 'close' } : {};
          sendError(res, status, safeMessage, type, code, headers);
          if (status === 413) {
            req.destroy();
          }
        } finally {
          res.off('close', onResClose);
          activeControllers.delete(abortController);
          activeRequests -= 1;
        }
        return;
      }

      sendError(res, 404, `Unhandled route: ${method} ${pathname}`, 'invalid_request_error', 'not_found');
    } catch (err) {
      const safeMessage = redactor.redact(err?.message || 'Unhandled bridge error');
      logger.error?.(`[cli-bridge] unhandled request error: ${safeMessage}`);
      sendError(res, 500, safeMessage, 'server_error', 'internal_error');
    }
  });

  // Ensure Node's HTTP server requestTimeout never cuts off valid turns allowed by CLI_BRIDGE_TIMEOUT_MS.
  server.requestTimeout = config.timeoutMs + config.killGraceMs + 10_000;

  const shutdown = () => {
    for (const controller of activeControllers) {
      controller.abort();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  };

  return { server, registry, redactor, shutdown };
}
