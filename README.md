# CVM Analytics Server

Minimal Context VM backend (Bun + TypeScript + SQLite) that tracks page visits per site UUID with device breakdowns. MCP-only; no HTTP API exposed.

## Quick start

1. Install deps: `bun install`
2. Optional env:
   - `SERVER_PRIVATE_KEY` (hex) — if omitted it will be generated and written to `.env`
   - `RELAYS` — comma-separated Nostr relays (defaults to `wss://relay.contextvm.org,wss://cvm.otherstuff.ai`)
3. Run: `bun run server.ts`
4. Data lives at `data/analytics.db` (auto-created).

## Client integration idea

Serve your own tiny script that calls the MCP tool `record_visit` (or front it with your own HTTP proxy). This repo does not expose any HTTP endpoints; all functionality is via MCP. Every visit call only needs the site UUID; mutating/listing actions should be invoked by the owner npub (Context VM signatures over Nostr handle authenticity).

## MCP tools

- `register_site` — create/update a site (requires `ownerNpub`, relies on signed MCP call).
- `record_visit` — increment counts for a page/device (requires site UUID only).
- `list_sites_for_npub` — list sites where `npub` matches the stored owner field (expects signed MCP call).
- `get_site_stats` — aggregated per-page stats for a site UUID (requires matching `npub`, expects signed MCP call).
- `health` — simple ping.

## Development tips

- Type-check: `bun run type-check`
- Hot dev: `bun run --watch server.ts`
- The server starts only MCP (Nostr) transport on boot.
