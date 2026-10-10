# AGENTS.md

Instructions for coding agents working in this repository (any agent: Claude Code, Codex, opencode, Cursor, …).

## Working on several issues or tasks at once

When asked to work on more than one issue or task (for example "work on issues 11, 12 and 14"), don't implement them yourself. Dispatch them to the swarm, which starts one agent per task, all coordinating through tower:

```sh
(set -a; . ./.dev.vars; npm run swarm -- --repo tower-src --init --pr --issues 11,12,14)
```

The subshell exports `TOWER_URL` and `TOWER_API_KEY` from `.dev.vars` (see `.dev.vars.example`) for this command only.

- `--issues` takes GitHub issue numbers; `--task "…"` adds free-text tasks (repeatable).
- `--init` creates the `tower-src` trunk from this checkout's HEAD.
- `--pr` fetches what landed into a `swarm/<timestamp>` branch, runs the repo's `typecheck` and `test` npm scripts (or `--checks "<cmd>"`) on the combined result, pushes it, opens a PR (with each agent's evidence, the combined check results, and `Closes #N` for landed issues), then tears the trunk down so the next run starts fresh from `main`. Always use `--init --pr` together.
- By default the swarm starts more of the agent that launched it: from Claude Code you get Claude Code agents, from opencode you get opencode agents. `--agent claude,opencode` picks explicitly and deals tasks out round-robin. Agents are defined in `swarm/agents.json`.
- Agents default to cheap models (Haiku for Claude Code). Add `--model sonnet` (or `--model claude=opus`) only when a run needs a stronger model.
- Point `TOWER_URL` at your `tower-dev` Worker for anything experimental. Use the production URL only for recorded demo runs.

A run takes roughly 10–30 minutes (each agent installs dependencies, codes, checks and lands), longer than most agents' shell-command time limits. Run it as a background command, wait for it to finish, then report the summary table (what landed, what didn't), the PR link, and where the logs are (`swarm-logs/`).

**If you are a swarm agent** (your prompt says you are one of several agents coordinating through the tower MCP tools), never run the swarm. Do your one task and follow the tower server's instructions.

## Project basics

- `npm run typecheck`: TypeScript check. Run it before landing any change.
- `npm test`: unit tests (Node) and Durable Object tests (workerd, Artifacts faked). No Cloudflare account needed. Run it before landing any change; CI runs both on every push.
- `npm run test:integration`: opt-in end-to-end run of the sim against `tower-dev` (needs `TOWER_API_KEY` and `wrangler login`). Spends Artifacts operations, so CI never runs it.
- `npm run dev`: local Worker against the `tower-dev` Artifacts namespace.
- `npm run sim -- --repo <name> --seed`: scripted agents for load and behavior testing; cleans up after itself.
- Architecture, API and MCP tools are described in `README.md`.
