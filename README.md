# Claude Code Usage Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![claude-code](https://img.shields.io/badge/claude--code-black?style=flat-square)](https://claude.ai/code)

**Pro and Max subscribers get a progress bar. This gives you the full picture.**

Claude Code writes detailed usage logs locally — token counts, models, sessions, projects — regardless of your plan. This dashboard reads those logs and turns them into charts and cost estimates. Works on API, Pro, and Max plans.

![Claude Usage Dashboard](docs/screenshot.png)

**Created by:** [The Product Compass Newsletter](https://www.productcompass.pm)

This was vibe-rewritten in TypeScript. Needs Node.js 24+ to run, zero dependencies.

---

## What this tracks

Works on **API, Pro, and Max plans** — Claude Code writes local usage logs regardless of subscription type. This tool reads those logs and gives you visibility that Anthropic's UI doesn't provide.

Captures usage from:

- **Claude Code CLI** (`claude` command in terminal)
- **VS Code extension** (Claude Code sidebar)
- **Dispatched Code sessions** (sessions routed through Claude Code)

**Not captured:**

- **Cowork sessions** — these run server-side and do not write local JSONL transcripts

---

## Requirements

- Node.js 24+
- No third-party runtime dependencies

This rewrite uses TypeScript executed directly by Node, plus the built-in SQLite module exposed as `node:sqlite`.

## Quick Start

No package install, no transpile step.

### Windows

```sh
git clone https://github.com/phuryn/claude-usage
cd claude-usage
npm run dashboard
```

### macOS / Linux

```sh
git clone https://github.com/phuryn/claude-usage
cd claude-usage
npm run dashboard
```

---

## Usage

```sh
# Scan JSONL files and populate the database (~/.claude/usage.db)
npm run scan

# Show today's usage summary by model (in terminal)
npm run today

# Show all-time statistics (in terminal)
npm run stats

# Scan + open browser dashboard at http://localhost:8080
npm run dashboard
```

The scanner is incremental — it tracks each file's path and modification time, so re-running `scan` is fast and only processes new or changed files.

---

## How it works

Claude Code writes one JSONL file per session to `~/.claude/projects/`. Each line is a JSON record; `assistant`-type records contain:

- `message.usage.input_tokens` — raw prompt tokens
- `message.usage.output_tokens` — generated tokens
- `message.usage.cache_creation_input_tokens` — tokens written to prompt cache
- `message.usage.cache_read_input_tokens` — tokens served from prompt cache
- `message.model` — the model used (e.g. `claude-sonnet-4-6`)

`src/scanner.ts` parses those files and stores the data in a SQLite database at `~/.claude/usage.db`.

`src/dashboard.ts` serves a single-page dashboard on `localhost:8080` with Chart.js charts (loaded from CDN). It auto-refreshes every 30 seconds and supports model filtering with bookmarkable URLs.

For local testing, you can override the default paths:

```sh
CLAUDE_USAGE_PROJECTS_DIR=/tmp/projects CLAUDE_USAGE_DB_PATH=/tmp/usage.db npm run scan
```

---

## Cost estimates

Costs are calculated using **Anthropic API pricing as of April 2026** ([claude.com/pricing#api](https://claude.com/pricing#api)).

**Only models whose name contains `opus`, `sonnet`, or `haiku` are included in cost calculations.** Local models, unknown models, and any other model names are excluded (shown as `n/a`).

| Model             | Input      | Output      | Cache Write | Cache Read |
| ----------------- | ---------- | ----------- | ----------- | ---------- |
| claude-opus-4-6   | $6.15/MTok | $30.75/MTok | $7.69/MTok  | $0.61/MTok |
| claude-sonnet-4-6 | $3.69/MTok | $18.45/MTok | $4.61/MTok  | $0.37/MTok |
| claude-haiku-4-5  | $1.23/MTok | $6.15/MTok  | $1.54/MTok  | $0.12/MTok |

> **Note:** These are API prices. If you use Claude Code via a Max or Pro subscription, your actual cost structure is different (subscription-based, not per-token).

---

## Files

| File               | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `src/scanner.ts`   | Parses JSONL transcripts, writes to `~/.claude/usage.db` |
| `src/dashboard.ts` | HTTP server + single-page HTML/JS dashboard              |
| `src/cli.ts`       | `scan`, `today`, `stats`, `dashboard` commands           |
| `src/db.ts`        | Shared `node:sqlite` database setup                      |
| `src/costs.ts`     | Shared pricing and formatting helpers                    |
