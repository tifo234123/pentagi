# PentAGI CLI Agent Bridge (`cli-bridge`)

Opt-in, zero-dependency Node 24 sidecar inspired by T3 Code's multi-CLI driver harness. Exposes an OpenAI-compatible `/v1/models` and `/v1/chat/completions` (plus unprefixed `/models` and `/chat/completions`, JSON + SSE) gateway for PentAGI's existing `custom` provider (`LLM_SERVER_URL`), allowing PentAGI flows and assistants to use external LLM CLIs (`claude`, `codex`, `gemini`, `opencode`, or any generic `stdio-json` CLI) while keeping **100% of PentAGI's rules, database persistence, GraphQL subscriptions, and Docker sandbox execution unchanged**.

## Security and PentAGI Rule Invariants

- **Disabled by default:** No driver can be called unless explicitly allowlisted in `CLI_BRIDGE_ENABLED_DRIVERS`.
- **Authenticated gateway:** All `/v1/*`, `/models`, and `/chat/completions` routes require `Authorization: Bearer <CLI_BRIDGE_API_KEY>` checked with SHA-256 + `crypto.timingSafeEqual`.
- **Isolated execution boundary:**
  - `claude` is invoked with `--tools ""`, `--strict-mcp-config`, `--mcp-config '{"mcpServers":{}}'`, `--setting-sources ""`, and `--no-session-persistence` so built-in tools, workspace hooks, and MCP servers are disabled and every tool call executes strictly inside PentAGI's `customExecutor` and per-flow Docker sandbox.
  - `codex` (`--sandbox read-only`) and `gemini` (`--output-format json`) must run inside the isolated `cli-bridge` container with `CLI_BRIDGE_WORK_DIR=/work` (empty workspace, no Docker socket, no mounted host credentials).
  - `opencode` is invoked as `opencode run --standalone --format json --archived --agent pentagi --model <model>` with the user turn on stdin. `--standalone` applies an inline primary agent from `OPENCODE_CONFIG_CONTENT` instead of the background server's built-in coding-assistant prompt. That agent sets `tools` to `{ "*": false }` and loads PentAGI's system prompt from a `0600` temp file via `{file:...}` so the prompt is not placed in argv or the child environment. `--archived` keeps bridge turns out of the user's session list. A client model `opencode/opencode-go/gpt-5.6-luna` is passed to the CLI as `opencode-go/gpt-5.6-luna`.
  - All `CLI_BRIDGE_*` environment variables are stripped before spawning any child process so external CLIs never inherit `CLI_BRIDGE_API_KEY` or `CLI_BRIDGE_REDACT_VALUES`.
- **No shell interpolation:** Binaries execute via `spawn(binary, argv, { shell: false, detached: true })` and model names are validated against `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`.
- **Process-group cancellation:** Closing the HTTP connection (when an operator stops a flow or assistant in PentAGI) or sending `SIGTERM` to the bridge signals the entire child process group (`-pid`, escalating to `SIGKILL` after `CLI_BRIDGE_KILL_GRACE_MS`) so grandchildren never leak or deadlock concurrency slots.
- **Secret scrubbing:** `CLI_BRIDGE_API_KEY` and any values in `CLI_BRIDGE_REDACT_VALUES` are redacted from logs, error envelopes, and 200 OK outputs.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CLI_BRIDGE_HOST` | `0.0.0.0` | Listen address |
| `CLI_BRIDGE_PORT` | `8090` | Listen port |
| `CLI_BRIDGE_API_KEY` | *(required)* | Bearer token matching PentAGI's `LLM_SERVER_KEY` |
| `CLI_BRIDGE_ENABLED_DRIVERS` | *(empty)* | Comma-separated allowlist (`claude`, `codex`, `gemini`, `opencode`, `stdio-json`) |
| `CLI_BRIDGE_DEFAULT_DRIVER` | *(empty)* | Optional default driver for unprefixed model IDs (must be enabled) |
| `CLI_BRIDGE_TIMEOUT_MS` | `120000` | Per-turn subprocess timeout in milliseconds (100–600000) |
| `CLI_BRIDGE_KILL_GRACE_MS` | `2000` | Grace period between `SIGTERM` and `SIGKILL` |
| `CLI_BRIDGE_MAX_OUTPUT_BYTES` | `1048576` | Hard cap on CLI stdout bytes per turn |
| `CLI_BRIDGE_MAX_REQUEST_BYTES` | `2097152` | Hard cap on incoming HTTP JSON body bytes |
| `CLI_BRIDGE_MAX_CONCURRENT` | `4` | Max simultaneous CLI invocations (returns HTTP 429 when full) |
| `CLI_BRIDGE_WORK_DIR` | `/work` (container) | Isolated working directory for CLI subprocesses |
| `CLI_BRIDGE_CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `CLI_BRIDGE_CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CLI_BRIDGE_GEMINI_BIN` | `gemini` | Path to Gemini CLI binary |
| `CLI_BRIDGE_OPENCODE_BIN` | `opencode` | Path to OpenCode CLI binary |
| `CLI_BRIDGE_OPENCODE_MODELS` | `opencode-go/gpt-5.6-luna,opencode-go/claude-haiku-5-5,opencode-go/deepseek-v4-pro,opencode-go/kimi-k3` | Comma-separated OpenCode model IDs (provider prefix kept; the `opencode/` driver prefix is stripped before `--model`) |
| `CLI_BRIDGE_STDIO_JSON_BIN` | *(empty)* | Path to generic JSON-stdio CLI binary |
| `CLI_BRIDGE_REDACT_VALUES` | *(empty)* | Extra comma-separated secret strings to scrub from logs, errors, and outputs |

## Installing CLI Binaries in the Sidecar Image

The base `Dockerfile` is intentionally minimal and does not bundle proprietary or third-party CLI packages by default. Pass `CLI_BRIDGE_NPM_PACKAGES` at build time (or point `CLI_BRIDGE_IMAGE` at a derived image) to install the CLIs you want enabled:

```bash
docker build \
  --build-arg CLI_BRIDGE_NPM_PACKAGES="@anthropic-ai/claude-code @openai/codex @google/gemini-cli" \
  -t local/pentagi-cli-bridge:workshop \
  ./cli-bridge
```

## Running Tests (100% Offline)

```bash
cd cli-bridge
node --test test/*.test.mjs
```
