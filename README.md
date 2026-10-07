# tower

Git traffic control for agents working on Git, built on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/).

Plain Git finds out about conflicts at merge time, after the work is done. With hundreds of agents that's backwards. In `tower`, an agent files a **flight plan** (its task and the paths it will touch) before it starts. The tower sequences overlapping plans, gives each cleared agent its own fork and a fork-scoped token, and lands each change onto trunk itself. Trunk never sees a textual merge conflict, and every landed commit remembers why it was made.

## Architecture

```
                         ┌──────────────── Worker (src/index.ts) ─────────────────┐
  agents / dashboard ──▶ │  /repos/:repo/*  ──auth──▶  TOWER.getByName(repo)      │
                         └────────────────────────────────┬───────────────────────┘
                                                          ▼
          ┌────────────── Tower Durable Object, one per trunk (src/tower.ts) ────────────┐
          │ SQLite: plans · lands · land_paths · stats · events   live feed (/live)      │
          │                                                                              │
          │  file plan ─▶ overlap check (src/claims.ts) ─▶ holding | cleared             │
          │  cleared   ─▶ trunk.fork() + fork.createToken("write")                       │
          │  land      ─▶ diff fork HEAD vs base (src/treediff.ts, binding readTree)     │
          │               ├─ path outside lease ─▶ 409 drift                             │
          │               └─ inside lease ─▶ overlay onto trunk HEAD + push (src/land.ts)│
          │  landed / released ─▶ delete the fork, re-clear holding plans                │
          └──────────────────────────────────┬───────────────────────────────────────────┘
                                             ▼
                     Artifacts namespace "tower": demo (trunk), demo--<planId> (forks)
```

**Leases.** A claim is a file (`src/auth/session.ts`) or a directory (`src/auth/` or `src/auth/**`). Two claims overlap when one equals or contains the other. A new plan waits behind every cleared plan it overlaps, and behind every earlier holding plan it overlaps, so the queue is FIFO and nothing jumps ahead. Leases are only as good as the claims behind them, so each claim is measured against trunk's file list. One covering more than 40 files, or (from 8 files up) more than 15% of trunk or a whole top-level directory, is refused as `claim_too_broad` with the files under it that fit the task (by name and by what lands of similar tasks changed); `force: true` overrides, and is counted. Limits are per trunk (`claim_max_files`, `claim_max_share`, `claim_min_files` in its meta). Paths that look guessed (a missing directory, a near-miss like `wrangler.toml` for `wrangler.jsonc`) come back as `warnings`, since creating files is legitimate. A holding plan's poll says which of its claims is held, by whom, and whether narrowing its own claim would let it start. Symbol-level claims, from a tree-sitter planning pass, are planned as a finer-grained layer on the same model.

**Isolation.** Every cleared plan gets its own Artifacts fork and short-lived write tokens scoped to that fork. Agents never hold trunk credentials. When the plan lands or is released, the fork is deleted. A landed fork's changes live on trunk, and its name stays in the commit's `Tower-Fork` trailer.

**Drift and the merge gate.** The tower diffs the fork's HEAD tree against the commit it forked from, using only the binding's `readCommit` and `readTree`. It descends only into subtrees whose hash changed. Any changed path outside the lease is drift: `POST …/check` reports it, and `POST …/land` refuses it with a 409. This needs no push-event subscription per fork. (Push events are subscribed per repo, so they're an optional live feed and not part of the core loop.)

**Landing.** The binding can read Git objects but can't write them. So the tower keeps an in-memory isomorphic-git workspace of trunk. To land, it copies the fork's changed blobs into the workspace, rewrites only the trees on the changed paths, commits on top of trunk HEAD, and pushes. Landing is serialized inside the Durable Object, and the tower is trunk's only writer. Throughput depends on how long each land holds that lock, so as little as possible happens inside it. The diff, the drift check and the fork's blobs are read before the lock is taken. Scoring reads trunk from the tower's own caches (each land carries trunk's file list forward). The trunk write token is reused, and trunk HEAD is taken from the last push. The fork is deleted after the lock is released. Because leases are disjoint, the overlay is conflict-free by construction. Semantic conflicts are a different problem; review-by-exception is meant to handle those.

**Memory.** Each landed commit carries `Tower-Plan`, `Tower-Agent` and `Tower-Fork` trailers. The agent's evidence (prompt, plan, test results, and so on) is stored against the trunk SHA. `GET …/why?path=` answers why a path looks the way it does, not just who changed it last.

## API

All routes are under `/repos/:repo` and require `Authorization: Bearer $TOWER_API_KEY`. The WebSocket route also accepts `?key=`. The optional read-only `TOWER_DASHBOARD_KEY` opens only `GET /live`, `/state`, `/events`, `/tree`, `/blob`, `/why` and `/plans/:id/diff`, so it is safe to show in a dashboard URL.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/init` `{importUrl?}` | Create or import trunk. Returns a seeding token. |
| POST | `/token` | A read-only trunk token (10 minutes) for fetching landed work. |
| DELETE | `/` | Tear down a trunk: delete it and any remaining forks, and reset the Tower's state. |
| POST | `/plans` `{agent, task, claims[], force?}` | File a flight plan. Returns `holding` (with `waiting`: why, per claim) or `cleared`, plus fork credentials if cleared, the claims' `coverage` of trunk and any `warnings`. A too-broad claim is refused with 422 `{error: "claim_too_broad", message, broad, suggested, coverage}`. |
| GET | `/plans/:id` | Poll a plan. Once cleared, returns the fork remote and a fresh fork token. |
| POST | `/plans/:id/check` | Report touched paths and drift so far. |
| GET | `/plans/:id/diff` | Read-only: the plan (from its events) and every file it changed, with old and new contents. A landed plan is diffed on trunk (its commit against the parent); a plan in flight in its fork (base against head, each file flagged `outside` its claims or not). Answered by the Worker, so viewing a plan is never its agent's heartbeat. |
| POST | `/plans/:id/amend` `{claims[], force?}` | Extend an active plan's claims. A too-broad new path is refused with 422 `claim_too_broad`. Free paths are granted at once; held paths wait (the plan keeps its fork and lease) until their holders land or release. An amendment that would close a wait cycle is refused with 409 `deadlock`. |
| POST | `/plans/:id/land` `{summary?, evidence?}` | Merge gate: land onto trunk, or 409 with the drifted paths. |
| POST | `/plans/:id/release` | Abandon a plan and free its airspace. |
| GET | `/state` | Active plans, recent lands (with their paths), stats. |
| GET | `/events?since=&plan=&limit=` | The event log in `seq` order: filed, holding (with `blockedBy`), cleared, provisioned, amended, amendment_held, deadlock, drift (with `paths`), landed, released and stat events. Pages of `limit` (default 1000, max 10000); pass the returned `last` as the next `since`. Keeps the last 50,000 events; cleared by `DELETE /`. |
| GET | `/tree` | Every file path on trunk HEAD, for the dashboard's codebase map. Cached until HEAD moves. |
| GET | `/why?path=` | Landed changes (with evidence) that touched a path. |
| GET | `/live?since=` (WebSocket) | A `state` snapshot (with the latest `seq`) on connect, then each event as it is logged. With `?since=<seq>`, the events after that seq instead of the snapshot, so a reconnecting client catches up without gaps (a fresh snapshot if they were pruned or the trunk was reset). |
| GET | `/<page>?key=` | A UI page from `web/`, such as `/dashboard` (no key needed to load it; it calls the API with its `?key=`). |
| GET | `/plans/:id?key=` (browser) | A plan's page (`web/plan.html`), served only when the request asks for HTML; API clients polling the same URL get the plan as before. |

## Dashboard

Open `https://tower-dev.<subdomain>.workers.dev/repos/<repo>/dashboard?key=$TOWER_DASHBOARD_KEY`. Set the key with `npx wrangler secret put TOWER_DASHBOARD_KEY [--env dev]`; the operator key works too. The header counts conflicts prevented, drift blocked, deadlocks prevented and landed. Below it, a throughput strip covers the last 10 minutes in 15-second buckets, with one small chart per measure: lands/min as bars, queue depth (plans holding) and agents in flight as lines. Each shows its current value and its peak, and you can hover a bucket for its time and value. The page stays readable with hundreds of plans. Events are drawn at most once per frame. The operator lists show the oldest 40 rows and count the rest. Holding plans are also summarized as one line per contested path ("37 on `src/modules/m0.ts`, next: …"). With more than 40 active plans, the map drops per-agent labels (hover a dot instead) and shows each path's queue as a single count. The page has two views:

- **Operator** (the default) lists in-flight plans with their agent, task, claims, fork and running time. Holding plans show what they wait on ("waiting on `claude-issue-11` for `src/tower.ts`"). In-flight plans also show held amendments and deadlock refusals. Lands are listed with their summary, files and sha, with the agent's evidence collapsed until you open it. The event feed lists every filing, hold, drift rejection (with its paths) and land, backfilled from the event log on load. Click any path to see why it looks the way it does. With the operator key this calls `/why`. The dashboard key can't read `/why`, so the page falls back to the lands it has seen.
- **Map** (`?view=map`, for demos) draws trunk as a treemap with labeled top-level regions. Each in-flight agent is a colored dot over a tinted region that carries the agent's name. Holding plans are dashed. The last few lands stay outlined in green, and drift flashes red. A legend and the trunk timeline stay on screen.

**Plans** (`/repos/<repo>/plans`) lists every plan in the event log, newest first, filterable by status. Each has a shareable page at `/repos/<repo>/plans/<id>`, the pull request without anyone opening one: the agent, the task (rendered markdown), its status and how long it spent in each state; its airspace (claims, and each amendment granted or held, and on whom); the lifecycle from the event log (filed, holding behind whom, cleared, amendments, drift with its paths, review, landed, released or expired); while in flight, the fork and the paths touched so far with any drift; once landed, the trunk SHA, every changed file with a diff, the risk score and the evidence. Every path links to the code explorer's history for it. `web/plan-model.js` is its DOM-free model (story, line diff, markdown), unit-tested in Node.

Agents get colors from a fixed palette in the order they are first seen, so `claude-issue-21` and `claude-issue-22` look different. Once the palette runs out, colors are hashed. **Replay** loads the trunk's event log and plays it back at 1–64× in either view. **Save log** downloads the log, and **Load log** replays a saved file, so a run can still be shown after its trunk is torn down.

The UI lives in `web/` and is served with Workers Static Assets: plain HTML, CSS and ES modules, with no build step. `web/styles.css` holds the palette and the top nav's styles. `web/client.js` holds the nav entries and the shared helpers: `api(path)` and `live(onEvent)`, both using the page's `?key=`, plus `el()`, `color()` and `ago()`. `web/model.js` is the dashboard's DOM-free model (event reduction, who waits on whom, colors), unit-tested in Node. To add a page, add `web/<page>.html` and a nav entry in `web/client.js`. It is then served at `/repos/:repo/<page>`. `npm run typecheck` also checks `web/` through JSDoc types (`web/tsconfig.json`).

## Agents: MCP

Tower is agent-agnostic. Any agent that speaks MCP can coordinate through it, and anything else can use the HTTP API above. Each trunk has an MCP endpoint at `/repos/:repo/mcp` (Streamable HTTP, same bearer key). Its tools are `suggest_claims`, `file_plan`, `wait_for_clearance`, `amend_claims`, `check`, `land`, `release`, `why` and `state`. The server's instructions teach the protocol, so the agent's prompt only needs the task and the repo name. Agents use plain `git` with the fork remote and token that `wait_for_clearance` returns.

```sh
# Claude Code
claude mcp add --transport http tower https://tower-dev.<subdomain>.workers.dev/repos/<repo>/mcp \
  --header "Authorization: Bearer $TOWER_API_KEY"
```

```jsonc
// opencode (opencode.json)
{ "mcp": { "tower": { "type": "remote", "url": "https://tower-dev.<subdomain>.workers.dev/repos/<repo>/mcp",
                      "headers": { "Authorization": "Bearer <TOWER_API_KEY>" } } } }
```

Tested with Claude Code (Haiku) and opencode (Gemini 3.5 Flash) running concurrently on one trunk. Both planned, cloned their forks, landed with evidence, and stayed inside their claims.

## Swarm

`npm run swarm` starts one agent per task, all coordinating through one trunk. It does no coordination itself: it builds each agent's prompt and MCP config, starts agents from `swarm/agents.json` (argv templates, so any MCP-capable agent works), waits, reports what landed, and releases plans left by agents that didn't finish.

```sh
TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... \
  npm run swarm -- --repo tower-src --init --pr --issues 11,12 --task "Fix the typo in README.md"
```

By default it starts more of whichever agent launched it: the nearest ancestor process that matches an agent's `detect` entry. Ask Claude Code to run it and you get Claude Code agents. `--agent a,b` mixes agents deliberately. `--init` creates the trunk from the current directory's HEAD. `--pr` fetches what landed into a `swarm/<timestamp>` branch, runs the `typecheck` and `test` npm scripts on the combined result (agents only check their own change, so a clash between disjoint claims shows up here; `--checks "<cmd>"` replaces them for repos that don't use npm), opens a GitHub PR with each agent's evidence and the combined check results (and `Closes #N` for landed issues), then tears the trunk down, so each run starts fresh from `main`. `--dry-run` prints the agent commands without running anything. `AGENTS.md` tells an agent working in this repo to dispatch multi-issue requests to the swarm.

## Running it

Requirements: Node 20+, `git`, a Cloudflare account on Workers Paid with Artifacts enabled, and Wrangler logged in with the `artifacts:write` scope (`npx wrangler login`).

There are two environments, each with its own Worker, Artifacts namespace and Tower state:

| Environment | Worker | Namespace | Use |
| --- | --- | --- | --- |
| `dev` | `tower-dev` | `tower-dev` | Testing and sims; wipe freely. `npm run dev` uses it too. |
| production | `tower` | `tower` | Demo runs only |

```sh
npm install
cp .dev.vars.example .dev.vars   # set TOWER_API_KEY
npm run dev                      # local Worker; Artifacts is always remote (tower-dev namespace)

# In another terminal: seed a trunk, run 8 agents over 4 modules (one drifts), then tear it all down
TOWER_API_KEY=... npm run sim -- --repo sim1 --seed --agents 8 --modules 4 --drift 1
```

With `--seed`, the sim deletes everything it created at the end (trunk, forks, Tower state). Pass `--keep` to inspect the trunk afterwards, and `curl -X DELETE …/repos/<repo>` to remove it later.

Deploy:

```sh
npm run deploy:dev && npx wrangler secret put TOWER_API_KEY --env dev   # https://tower-dev.<subdomain>.workers.dev
npm run deploy     && npx wrangler secret put TOWER_API_KEY             # https://tower.<subdomain>.workers.dev
```

Cost: Artifacts bills operations and storage (Workers Paid includes 10,000 operations and 1 GB per month). Repos persist until deleted, which is why forks and sim trunks are cleaned up automatically.

## Scale

`npm run sim` drives hundreds of scripted agents through the full loop: file, wait, clone the fork, commit, push, land. Each agent picks one of `--modules` files from a Zipf distribution (`--zipf 1`, so `m0` is the hottest and the tail is quiet). Starts are spread over `--stagger` seconds, and git runs at most `--git` (24) at a time. When the run ends, the sim replays the event log and prints throughput. With `--seed`, it then clones trunk and checks for conflicts: every module must hold exactly the lines of the agents that picked it, and trunk must have exactly one commit per land. `--out run.json` saves the metrics and the full event log, and the dashboard's **Load log** replays the file.

```sh
TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... \
  npm run sim -- --repo scale --seed --agents 500 --modules 50 --stagger 30 --quiet --out scale.json
```

| Metric | Meaning |
| --- | --- |
| plans/min, lands/min | Filed and landed plans over the run, plus the busiest minute of lands |
| time holding p50/p95 | From filing to clearance, read from the event log |
| land latency p50/p95 | Client-side time for `POST …/land` |
| max queue depth / in flight / active | Most plans holding, cleared, and both at once |
| `artifactsCalls` | Calls the tower made into the Artifacts binding (`stats.artifacts_calls`), an upper bound on billed operations. Add the sim's own git clones and pushes. |
| conflicts | Modules whose content on trunk isn't exactly what their agents wrote |

**Recorded run (2026-10-06): 250 agents, 0 conflicts.** This ran against the deployed `tower-dev` Worker, whose server code predates the landing changes below: `npm run sim -- --repo scale28-r250 --seed --agents 250 --modules 50 --stagger 20 --quiet`. All 250 agents filed within 20 seconds, and up to 246 plans were active at once. The hottest module, `m0`, drew 51 of them, then `m1` 33 and `m2` 17. Every agent landed. Trunk ended with exactly one commit per land, and every module held exactly its agents' lines.

| | |
| --- | --- |
| agents · modules · duration | 250 · 50 (Zipf 1) · 14 min 22 s |
| plans/min · lands/min (busiest minute) | 17.4 · 17.4 (25) |
| time holding p50 / p95 | 5 min 4 s / 12 min 5 s |
| land latency p50 / p95 | 31.3 s / 114.5 s |
| max queue depth · max in flight · max active | 202 · 44 · 246 |
| conflicts prevented · conflicts on trunk · failed agents | 206 · 0 · 0 |
| events logged | 3,795, of which 2,339 were repeated `holding` announcements |
| Artifacts | ~10 tower calls per agent (123 for 12 agents, metered locally on both the recorded server code and the new code), plus 251 git pushes and 251 clones from the sim (counting the seed push and the verification clone): about 3,100 operations, or ~$0.45 beyond the included 10,000 |

**Bottlenecks the run exposed:**

- **Landing serialization, the ceiling.** Lands arrived every 2.6 s (p50), so landing topped out at about 20–25 a minute however many agents were ready. With 44 agents holding forks, a land waited up to two minutes for the lock. In the old code, the lock covered everything: the fork diff, risk scoring (a full trunk walk), trunk `log`/`info`, creating and revoking a token, the push, and deleting the fork. Now it covers scoring from caches and the push. With the same local setup (12 agents on one module, `wrangler dev` against `tower-dev` Artifacts), in-lock time per land fell from a median of 8.7 s (7.0–10.7 s) to 2.7 s (2.4–4.2 s), and land latency p50 from 8.3 s to 4.9 s. Local timings include the round trips from a laptop to Artifacts, so deployed times are lower in both cases.
- **Broadcast fan-out.** Each land re-announced every plan queued behind it, because its `blockedBy` got shorter. That is O(queue²) events, each carrying the full plan, to every dashboard. A queued plan is now announced again only when it waits on someone new. The dashboard works out who is ahead on its own. The same 12-agent run logs 82 events instead of 137, and a queue of N plans costs N `holding` events instead of about N²/2. Closing a plan also re-checks only the plans that waited on it, against one parsed copy of the airspace rather than a re-query per plan.
- **Fork creation** kept up: cleared to provisioned took 3.6 s at p50 and 4.7 s at p95 (7.7 s at most). **`/state`** stayed small: 93 KB with 239 active plans, answered in 0.2 s. Neither needed changing.
- **Treemap and lists with hundreds of plans.** See Dashboard above. Replaying this run's log at 64× drew no frame slower than 17 ms.

To re-measure the landing changes once they are deployed, run `npm run deploy:dev` (when no swarm is using `tower-dev`), then repeat the command above with `--out run.json`. Its `artifactsCalls` line then comes from the tower itself.

## Roadmap

- [x] Live dashboard: a codebase map with agents as dots claiming regions, and a "conflicts prevented" counter
- [ ] Review by exception: score each land by risk, auto-land low-risk changes, and send the rest to a small human inbox
- [ ] Symbol-level claims with a tree-sitter planning pass
- [ ] Real LLM agents alongside scripted ones; a demo repo that's a Worker app, so Workers Builds gives every fork a preview URL
- [ ] Optional: tournament mode for contested tasks

## License

MIT
