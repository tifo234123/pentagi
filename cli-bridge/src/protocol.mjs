/**
 * OpenAI Chat Completions <-> CLI Driver wire protocol translator tailored to
 * PentAGI's ProviderCustom (langchaingo/llms/openai) contract.
 */

export function formatOpenAiError(message, type = 'server_error', code = null) {
  return {
    error: {
      message: String(message || 'internal bridge error'),
      type,
      param: null,
      code,
    },
  };
}

/**
 * Fixed-width tool-call ID generator (`call_000001`).
 * PentAGI's GetToolCallIDTemplate samples these IDs to normalize chains across
 * turns and provider switches, so width and prefix remain deterministic.
 */
export function createCallIdGenerator(start = 0) {
  let counter = start;
  return () => {
    counter += 1;
    return `call_${String(counter).padStart(6, '0')}`;
  };
}

export function validateChatRequest(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { ok: false, error: 'Request field "messages" must be a non-empty array' };
  }
  for (let i = 0; i < payload.messages.length; i += 1) {
    const msg = payload.messages[i];
    if (typeof msg !== 'object' || msg === null || typeof msg.role !== 'string' || !msg.role.trim()) {
      return { ok: false, error: `messages[${i}] must be an object with a non-empty string "role"` };
    }
  }
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
    return { ok: false, error: 'Request field "tools" must be an array when provided' };
  }
  const tools = Array.isArray(payload.tools)
    ? payload.tools.filter((t) => t && typeof t === 'object' && t.function && typeof t.function.name === 'string')
    : [];

  const responseFormat =
    payload.response_format && typeof payload.response_format === 'object' && !Array.isArray(payload.response_format)
      ? payload.response_format
      : null;

  return {
    ok: true,
    model: typeof payload.model === 'string' ? payload.model.trim() : '',
    messages: payload.messages,
    tools,
    toolChoice: payload.tool_choice ?? 'auto',
    responseFormat,
    stream: Boolean(payload.stream),
    maxTokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : undefined,
  };
}

function flattenContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'text' && typeof part.content === 'string') return part.content;
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function isJsonResponseFormat(responseFormat) {
  const t = responseFormat?.type;
  return t === 'json_object' || t === 'json_schema';
}

/**
 * Serialize OpenAI messages + PentAGI tool definitions into a deterministic prompt
 * that instructs the CLI driver to act purely as PentAGI's reasoning planner and
 * return structured JSON when tools or JSON response_format are requested.
 */
export function buildBridgePrompt({ messages, tools = [], toolChoice = 'auto', responseFormat = null }) {
  const sections = [];

  sections.push(
    [
      'You are acting as the reasoning model inside PentAGI under PentAGI execution rules.',
      'Do NOT execute shell commands, edit host files, or use local CLI tools directly.',
      'All actions must be requested exclusively through the declared PentAGI tools below.',
    ].join(' ')
  );

  const toolsActive = tools.length > 0 && toolChoice !== 'none';

  if (toolsActive) {
    const schemaBlocks = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    }));

    let choiceInstruction =
      'Choose one or more tools when an action or barrier completion is needed, or return plain text in "content" with an empty "tool_calls" array if answering directly.';
    if (toolChoice === 'required') {
      choiceInstruction = 'You MUST return at least one valid tool call in "tool_calls".';
    } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
      choiceInstruction = `You MUST call the tool named "${toolChoice.function.name}".`;
    }

    sections.push(
      [
        '## Available PentAGI Tools',
        JSON.stringify(schemaBlocks, null, 2),
        '',
        '## Required Output Format',
        choiceInstruction,
        'Respond ONLY with a single valid JSON object matching this exact schema (no extra commentary outside JSON):',
        '{"content": string | null, "tool_calls": [{"name": "<tool_name>", "arguments": { ... }}]}',
      ].join('\n')
    );
  } else if (isJsonResponseFormat(responseFormat)) {
    const schemaNote =
      responseFormat.type === 'json_schema' && responseFormat.json_schema
        ? `\nJSON Schema:\n${JSON.stringify(responseFormat.json_schema, null, 2)}`
        : '';
    sections.push(
      `## Required Output Format\nRespond ONLY with a single valid raw JSON object (no Markdown fences or surrounding commentary).${schemaNote}`
    );
  }

  const transcript = messages.map((msg) => {
    const role = String(msg.role || 'user').toUpperCase();
    const parts = [];
    const text = flattenContent(msg.content);
    if (text) parts.push(text);
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      parts.push(`TOOL_CALLS: ${JSON.stringify(msg.tool_calls)}`);
    }
    if (msg.tool_call_id) {
      parts.push(`(tool_call_id=${msg.tool_call_id}${msg.name ? `, name=${msg.name}` : ''})`);
    }
    return `[${role}]\n${parts.join('\n')}`;
  });

  sections.push(`## Conversation Transcript\n${transcript.join('\n\n')}`);
  return sections.join('\n\n');
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractJsonObject(raw, predicate = () => true) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  // 1. Direct JSON object
  const direct = tryParseJson(trimmed);
  if (direct && typeof direct === 'object' && !Array.isArray(direct) && predicate(direct)) {
    return direct;
  }

  // 2. Iterate ALL Markdown code fences so earlier non-JSON fences never shadow the JSON block
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = tryParseJson(match[1].trim());
    if (fenced && typeof fenced === 'object' && !Array.isArray(fenced) && predicate(fenced)) {
      return fenced;
    }
  }

  // 3. Balanced top-level object inside surrounding prose (track strings only when depth > 0)
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (depth > 0 && inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (depth > 0 && ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
        inString = false;
        escaped = false;
      }
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const candidate = tryParseJson(trimmed.slice(start, i + 1));
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && predicate(candidate)) {
          return candidate;
        }
        start = -1;
      }
    }
  }

  return null;
}

function normalizeArguments(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return '{}';
  if (typeof rawArgs === 'string') {
    const parsed = tryParseJson(rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    return '{}';
  }
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return JSON.stringify(rawArgs);
  }
  return '{}';
}

function isBridgeEnvelope(obj) {
  return 'tool_calls' in obj || 'content' in obj;
}

/**
 * Parse raw CLI assistant text or structured driver output into normalized
 * OpenAI assistant message fields ({ content, toolCalls, finishReason }).
 */
export function parseCliModelOutput(
  driverOutput,
  tools = [],
  nextCallId = createCallIdGenerator(),
  { toolChoice = 'auto', responseFormat = null } = {}
) {
  const toolsDisabled = toolChoice === 'none' || tools.length === 0;
  const forcedToolName =
    toolChoice && typeof toolChoice === 'object' && typeof toolChoice.function?.name === 'string'
      ? toolChoice.function.name.trim()
      : null;

  const allowedNames = forcedToolName
    ? new Set([forcedToolName])
    : new Set(tools.map((t) => t.function.name));

  let candidate = null;
  let fallbackText = '';

  if (driverOutput && typeof driverOutput === 'object' && !Array.isArray(driverOutput)) {
    const hasExplicitContent = 'content' in driverOutput && driverOutput.content !== undefined;
    const hasExplicitCalls = Array.isArray(driverOutput.tool_calls);

    if (hasExplicitCalls || hasExplicitContent) {
      candidate = driverOutput;
      if (typeof driverOutput.text === 'string') {
        fallbackText = driverOutput.text;
      }
    } else if (typeof driverOutput.text === 'string') {
      fallbackText = driverOutput.text;
      if (!toolsDisabled) {
        candidate = extractJsonObject(driverOutput.text, isBridgeEnvelope);
      }
    }
  } else {
    fallbackText = String(driverOutput ?? '');
    if (!toolsDisabled) {
      candidate = extractJsonObject(fallbackText, isBridgeEnvelope);
    }
  }

  const normalizedCalls = [];
  if (!toolsDisabled && candidate && Array.isArray(candidate.tool_calls)) {
    for (const rawCall of candidate.tool_calls) {
      if (!rawCall || typeof rawCall !== 'object') continue;
      const fnName =
        typeof rawCall.name === 'string'
          ? rawCall.name.trim()
          : typeof rawCall.function?.name === 'string'
            ? rawCall.function.name.trim()
            : '';
      if (!fnName) continue;
      if (allowedNames.size > 0 && !allowedNames.has(fnName)) continue;

      const rawArgs = rawCall.arguments !== undefined ? rawCall.arguments : rawCall.function?.arguments;
      normalizedCalls.push({
        id: nextCallId(),
        type: 'function',
        function: {
          name: fnName,
          arguments: normalizeArguments(rawArgs),
        },
      });
    }
  }

  if (normalizedCalls.length > 0) {
    const content =
      candidate && typeof candidate.content === 'string' && candidate.content.trim() !== ''
        ? candidate.content
        : null;
    return {
      content,
      toolCalls: normalizedCalls,
      finishReason: 'tool_calls',
    };
  }

  let content = fallbackText;
  if (candidate && typeof candidate.content === 'string') {
    content = candidate.content;
  } else if (candidate && candidate.content === null) {
    // Valid bridge JSON envelope with null content: never leak raw wrapper JSON back to PentAGI.
    content = '';
  }

  let finalContent = String(content ?? '').trim();
  if (isJsonResponseFormat(responseFormat) && finalContent) {
    const extracted = extractJsonObject(finalContent);
    if (extracted) {
      finalContent = JSON.stringify(extracted);
    }
  }

  return {
    content: finalContent,
    toolCalls: [],
    finishReason: 'stop',
  };
}

function normalizeUsage(usage) {
  const promptTokens = Number.isFinite(Number(usage?.prompt_tokens)) ? Number(usage.prompt_tokens) : 0;
  const completionTokens = Number.isFinite(Number(usage?.completion_tokens))
    ? Number(usage.completion_tokens)
    : 0;
  const totalTokens = Number.isFinite(Number(usage?.total_tokens))
    ? Number(usage.total_tokens)
    : promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function formatCompletionResponse({ id, created, model, parsed, usage }) {
  const message = {
    role: 'assistant',
    content: parsed.content,
  };
  if (parsed.toolCalls.length > 0) {
    message.tool_calls = parsed.toolCalls;
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: parsed.finishReason,
      },
    ],
    usage: normalizeUsage(usage),
  };
}

export function writeSseCompletion(res, { id, created, model, parsed, usage, chunkSize = 64 }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const emit = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`
    );
  };

  emit({ role: 'assistant' });

  if (parsed.toolCalls.length > 0) {
    if (parsed.content) {
      emit({ content: parsed.content });
    }
    emit({
      tool_calls: parsed.toolCalls.map((call, index) => ({ index, ...call })),
    });
  } else if (parsed.content) {
    // Slice by Unicode code points so 4-byte characters never split surrogate pairs across SSE frames.
    const codePoints = Array.from(parsed.content);
    for (let i = 0; i < codePoints.length; i += chunkSize) {
      emit({ content: codePoints.slice(i, i + chunkSize).join('') });
    }
  }

  emit({}, parsed.finishReason);

  if (usage) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: normalizeUsage(usage),
      })}\n\n`
    );
  }

  res.write('data: [DONE]\n\n');
  res.end();
}
