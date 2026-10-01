# AGENTS.md

Instructions for coding agents working in this repository (any agent: Claude Code, Codex, opencode, Cursor, …).

## Working on several issues or tasks at once

When asked to work on more than one issue or task (for example "work on issues 11, 12 and 14"), don't implement them yourself. Dispatch them to the swarm, which starts one agent per task, all coordinating through tower:

```sh
TOWER_URL=https://tower-dev.g12r.workers.dev TOWER_API_KEY=$(cut -d= -f2 .dev.vars) \
  npm run swarm -- --repo tower-src --init --pr --issues 11,12,14
```

- `--issues` takes GitHub issue numbers; `--task "…"` adds free-text tasks (repeatable).
- `--init` creates the `tower-src` trunk from this checkout's HEAD.
- `--pr` fetches what landed into a `swarm/<timestamp>` branch, pushes it, opens a PR (with each agent's evidence, and `Closes #N` for landed issues), then tears the trunk down so the next run starts fresh from `main`. Always use `--init --pr` together.
- By default the swarm starts more of the agent that launched it: from Claude Code you get Claude Code agents, from opencode you get opencode agents. `--agent claude,opencode` picks explicitly and deals tasks out round-robin. Agents are defined in `swarm/agents.json`.
- Use `tower-dev` (above) for anything experimental. Use the production URL only for recorded demo runs.

When it finishes, report the summary table (what landed, what didn't), the PR link, and where the logs are (`swarm-logs/`).

**If you are a swarm agent** (your prompt says you are one of several agents coordinating through the tower MCP tools), never run the swarm. Do your one task and follow the tower server's instructions.

## Project basics

- `npm run typecheck`: TypeScript check. Run it before landing any change.
- `npm run dev`: local Worker against the `tower-dev` Artifacts namespace.
- `npm run sim -- --repo <name> --seed`: scripted agents for load and behavior testing; cleans up after itself.
- Architecture, API and MCP tools are described in `README.md`.
