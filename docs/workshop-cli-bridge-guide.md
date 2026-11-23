# Workshop Isolated Stack and CLI Bridge Guide

This guide explains how to run an isolated PentAGI workshop instance alongside an existing live PentAGI installation without colliding on containers, networks, host ports, cookies, PostgreSQL data, or per-flow sandbox port ranges.

## Isolation Boundaries

| Resource | Live Base Stack | E2E Stack | Workshop Stack |
| --- | --- | --- | --- |
| Compose project | `pentagi` | `pentagi-e2e` | `pentagi-workshop` |
| PentAGI HTTPS port | `127.0.0.1:8443` | `127.0.0.1:8444` | `127.0.0.1:8445` |
| PostgreSQL port | `127.0.0.1:5432` | `127.0.0.1:5433` | `127.0.0.1:5435` |
| Scraper port | `127.0.0.1:9443` | internal | `127.0.0.1:9445` |
| Sandbox port range | `28000–29999` | `30000–31999` | `32000–33999` |
| `TENANT_ID` | *(empty)* | *(empty)* | `workshop` |
| Networks | `pentagi-network` (+2) | `pentagi-e2e-*` | `pentagi-workshop-*` |

## 1. Prepare Workshop Environment

```bash
cp examples/env.workshop.example .env.workshop
```

Edit `.env.workshop` to set a unique `WORKSHOP_COOKIE_SIGNING_SALT`, `CLI_BRIDGE_API_KEY`, and your allowlisted `CLI_BRIDGE_ENABLED_DRIVERS`. Never point `--env-file` at your live installation's `.env`.

## 2. Validate Rendered Compose Configuration

```bash
docker compose -p pentagi-workshop --env-file examples/env.workshop.example \
  -f docker-compose.yml -f docker-compose.workshop.yml -f docker-compose-cli-bridge.yml \
  config --quiet
```

## 3. Launch Isolated Workshop + CLI Bridge

```bash
docker compose -p pentagi-workshop --env-file .env.workshop \
  -f docker-compose.yml -f docker-compose.workshop.yml -f docker-compose-cli-bridge.yml \
  up -d --build --wait --wait-timeout 240
```

Open `https://127.0.0.1:8445` and select the `custom` provider (or create named provider profiles in Settings pointing to any model returned by `cli-bridge`'s `/v1/models`). All flows and assistants execute under PentAGI's exact unmodified rules and sandbox boundaries.

## 4. Scoped Teardown (Leaves Live Stack Untouched)

```bash
docker compose -p pentagi-workshop --env-file .env.workshop \
  -f docker-compose.yml -f docker-compose.workshop.yml -f docker-compose-cli-bridge.yml \
  down -v
```

Any per-flow sandbox containers created by the workshop instance carry the `pentagi.tenant=workshop` Docker label and can be listed safely with `docker ps -a --filter label=pentagi.tenant=workshop`.
