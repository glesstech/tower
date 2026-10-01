# AGENTS.md

Instructions for coding agents working in this repository (any agent: Claude Code, Codex, opencode, Cursor, …).

## Working on several issues or tasks at once

When asked to work on more than one issue or task (for example "work on issues 11, 12 and 14"), don't implement them yourself. Dispatch them to the swarm, which starts one agent per task, all coordinating through tower:

```sh
TOWER_URL=https://tower-dev.g12r.workers.dev TOWER_API_KEY=$(cut -d= -f2 .dev.vars) \
  npm run swarm -- --repo tower-src --init --issues 11,12,14
```

- `--issues` takes GitHub issue numbers; `--task "…"` adds free-text tasks (repeatable).
- `--init` creates the `tower-src` trunk from this checkout's HEAD the first time; after that it's reused.
- Agents come from `swarm/agents.json` and are dealt out round-robin; `--agent <name>` uses just one.
- Use `tower-dev` (above) for anything experimental. Use the production URL only for recorded demo runs.

When it finishes, report the summary table (what landed, what didn't) and where the logs are (`swarm-logs/`).

**If you are a swarm agent** (your prompt says you are one of several agents coordinating through the tower MCP tools), never run the swarm. Do your one task and follow the tower server's instructions.

## Project basics

- `npm run typecheck`: TypeScript check. Run it before landing any change.
- `npm run dev`: local Worker against the `tower-dev` Artifacts namespace.
- `npm run sim -- --repo <name> --seed`: scripted agents for load and behavior testing; cleans up after itself.
- Architecture, API and MCP tools are described in `README.md`.
