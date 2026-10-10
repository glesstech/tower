# tower

Tower coordinates many coding agents that change one Git repository at the same time. It runs on Cloudflare Workers and Durable Objects, and keeps every repo in [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/).

Plain Git finds conflicts at merge time, after the work is done. With hundreds of agents, that is too late. In tower, an agent files a **flight plan** before it starts: its task and the paths it will change. Tower queues plans whose paths overlap and gives each cleared agent a private fork with a token scoped to that fork. When the agent asks to land, tower checks that the change stayed inside its claims, scores its risk, and commits it onto trunk itself. Low-risk changes land at once. The rest wait for a human. Trunk never sees a textual merge conflict, and every landed commit records why it was made.

## How it works

```
                         ┌──────────────── Worker (src/index.ts) ─────────────────┐
  agents / browsers ───▶ │  /repos/:repo/*  ──auth──▶  TOWER.getByName(repo)      │
                         │  /repos/:repo/mcp (MCP tools)   web/ (static UI pages) │
                         └────────────────────────────────┬───────────────────────┘
                                                          ▼
          ┌────────────── Tower Durable Object, one per trunk (src/tower.ts) ────────────┐
          │ SQLite: plans · lands · land_paths · stats · events      live feed (/live)   │
          │                                                                              │
          │  file plan ─▶ claim checks (src/claims.ts) ─▶ holding | cleared              │
          │  cleared   ─▶ trunk.fork() + fork.createToken("write")                       │
          │  land      ─▶ diff fork HEAD against base (src/treediff.ts)                  │
          │               ├─ path outside the lease ─▶ 409 drift                         │
          │               └─ inside ─▶ risk score (src/risk.ts)                          │
          │                            ├─ low ─▶ overlay onto trunk and push (src/land.ts)│
          │                            └─ review ─▶ human inbox (202)                    │
          │  landed / released / expired ─▶ delete the fork, clear what waited on it     │
          │  alarm     ─▶ expire cleared plans whose agents went silent                  │
          └──────────────────────────────────┬───────────────────────────────────────────┘
                                             ▼
                Artifacts namespace: <repo> (trunk), <repo>--<planId> (forks)
```

**Leases.** A claim is a file (`src/auth/session.ts`) or a directory (`src/auth/` or `src/auth/**`). Two claims overlap when one equals or contains the other. A new plan waits behind every cleared plan it overlaps, and behind every earlier holding plan it overlaps. The queue is first in, first out, and nothing jumps ahead. A holding plan's poll says which of its claims is held, by whom, and whether narrowing its own claim would let it start.

**Claim hygiene.** One agent that claims `src/` makes everyone else wait, so tower measures each claim against trunk's file list. A claim is refused with 422 `claim_too_broad` when it covers more than 40 files. From 8 files up, it is also refused when it covers more than 15% of trunk or a whole top-level directory. The refusal lists files under the claim that fit the task, ranked by name and by what lands of similar tasks changed. `force: true` overrides the refusal, and the dashboard counts every forced claim. Each trunk can change the limits with `claim_max_files`, `claim_max_share` and `claim_min_files` in its meta. Paths that look guessed, such as a missing directory or `wrangler.toml` when trunk has `wrangler.jsonc`, come back as `warnings` rather than errors, because agents may create new files.

**Isolation.** Each cleared plan gets its own Artifacts fork and a one-hour write token scoped to that fork. Agents never hold trunk credentials. When the plan lands or is released, tower deletes the fork. The fork's name stays in the landed commit's `Tower-Fork` trailer.

**Lease expiry.** Every agent call on a plan (poll, check, amend, land or heartbeat) refreshes its lease. A Durable Object alarm expires a cleared plan that stays silent past its TTL: 15 minutes by default, 1 to 60 minutes if the plan asks for one when it is filed. Expiring a plan releases its claims and deletes its fork, like `release`. A plan waiting in the review inbox has no agent to hear from, so its lease is paused.

**Drift.** Tower diffs the fork's HEAD tree against the commit the fork started from, using only the binding's `readCommit` and `readTree`. It descends only into subtrees whose hash changed. A changed path outside the lease is drift. `POST …/check` reports it, and `POST …/land` refuses it with 409. Tower needs no push-event subscription per fork.

**Review by exception.** Each land gets a risk score before it reaches trunk (`src/risk.ts`). The score adds up blast radius (how many trunk files import what changed), diff size, and missing or failing test evidence. Some reasons send a change to review whatever its score:
- a sensitive path, such as auth, billing, CI config, migrations, deploy config or secrets
- checks that reported failures
- a semantic overlap, meaning a land since the fork started touched a file that imports, or is imported by, what this change touched
- a deleted module that trunk still imports

Low-risk changes land at once. The rest answer 202 and wait in the inbox, grouped so that similar changes, such as "12 dependency bumps", take one decision. A human approves (tower lands exactly what was scored), rejects (tower releases the plan), or sends the change back (the agent keeps its fork and lease, pushes again, and lands again).

**Landing.** The binding can read Git objects but can't write them. Tower therefore keeps an in-memory isomorphic-git workspace of trunk. To land, it copies the fork's changed blobs into the workspace, rewrites only the trees on the changed paths, commits on top of trunk HEAD, and pushes. Landing runs one at a time inside the Durable Object, and tower is trunk's only writer. The time each land holds that lock caps throughput, so tower does as little as possible inside it:
- It reads the diff, the drift check and the fork's blobs before it takes the lock.
- It scores from its own caches, because each land carries trunk's file list forward.
- It reuses the trunk write token, and takes trunk HEAD from the last push.
- It deletes the fork after it releases the lock.

Leases are disjoint, so the overlay can't produce a textual conflict.

**Memory.** Each landed commit carries `Tower-Plan`, `Tower-Agent` and `Tower-Fork` trailers. Tower stores the agent's evidence (its request, plan and check results) against the trunk SHA. `GET …/why?path=` returns the lands that touched a path, with their tasks and evidence, so an agent can read why code looks the way it does before it changes it.

## API

All routes below are under `/repos/:repo` and need `Authorization: Bearer $TOWER_API_KEY`. The WebSocket route also accepts `?key=`. The optional read-only `TOWER_DASHBOARD_KEY` opens only `GET /live`, `/state`, `/events`, `/tree`, `/blob`, `/why`, `/plans/:id/diff` and `/inbox`, so you can show it in a dashboard URL. Deciding (`POST /inbox/decide`) needs the operator key. If `TOWER_DEMO_REPO` names a trunk, those same read-only routes need no key for that trunk.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/init` `{importUrl?}` | Create or import trunk. Returns a token for seeding it. |
| POST | `/token` | A read-only trunk token, valid for 10 minutes, for fetching landed work. |
| DELETE | `/` | Tear down a trunk: delete it and any remaining forks, and reset the Tower's state. |
| POST | `/plans` `{agent, task, claims[], ttl?, force?}` | File a flight plan. Returns `holding` with `waiting` (why, per claim), or `cleared` with fork credentials. Both carry the claims' `coverage` of trunk and any `warnings`. A claim that is too broad gets 422 `{error: "claim_too_broad", message, broad, suggested, coverage}`. |
| GET | `/plans/:id` | Poll a plan. Once it is cleared, returns the fork remote and a fresh fork token. |
| POST | `/plans/:id/heartbeat` | Keep the lease alive. Returns when it expires. |
| POST | `/plans/:id/check` | Report the paths touched so far and any drift. |
| GET | `/plans/:id/diff` | Read only. The plan, from its events, and every file it changed with old and new contents. A landed plan is diffed on trunk against its parent commit. A plan in flight is diffed in its fork, and each file is flagged when it is `outside` the claims. The Worker answers this route, so viewing a plan never counts as its agent's heartbeat. |
| POST | `/plans/:id/amend` `{claims[], force?}` | Extend an active plan's claims. Free paths are granted at once. Held paths wait until their holders land or release, and the plan keeps its fork and lease meanwhile. A new path that is too broad gets 422 `claim_too_broad`. An amendment that would close a wait cycle gets 409 `deadlock`. |
| POST | `/plans/:id/land` `{summary?, evidence?, author?}` | Land onto trunk (200 with the SHA and risk), queue for review (202), or refuse with 409 and the drifted paths. |
| POST | `/plans/:id/release` | Abandon a plan and free its claims. A plan in review is the human's to decide, so this gets 409. |
| GET | `/inbox` | Changes waiting for a human, one entry per group, and a headline such as "N agents, 0 conflicts reached a human, K decisions required". |
| POST | `/inbox/decide` `{decision, group \| plans, note?}` | Apply `approve`, `reject` or `send_back` to a whole group or to listed plans. Reports each plan's outcome. |
| GET | `/state` | Active plans, the 50 most recent lands with their paths, and stats. |
| GET | `/events?since=&plan=&limit=` | The event log in `seq` order: filed, holding (with `blockedBy`), cleared, provisioned, amended, amendment_held, deadlock, drift (with `paths`), review, sent_back, landed, released, expired and stat. Pages hold `limit` events (default 1000, at most 10000). Pass the returned `last` as the next `since`. Tower keeps the last 50,000 events, and `DELETE /` clears them. |
| GET | `/tree` | Every file path on trunk HEAD. Cached until HEAD moves. |
| GET | `/blob?path=` | One file's contents on trunk HEAD. Binary files and files over 1 MB come back without text. |
| GET | `/why?path=&limit=` | Lands that touched a file, or anything under a directory, newest first, with their evidence. 20 by default, at most 1000. |
| GET | `/live?since=` (WebSocket) | A `state` snapshot (with the latest `seq`) on connect, then each event as tower logs it. With `?since=<seq>`, tower sends the events after that seq instead of the snapshot, so a client that reconnects catches up without gaps. If those events were pruned or the trunk was reset, the client gets a fresh snapshot. |

Outside a trunk, `GET /repos` lists trunks with live counts. The operator key sees every trunk. Without a key, it shows only the demo trunk.

## UI

The UI lives in `web/` and is served with Workers Static Assets. It is plain HTML, CSS and ES modules with no build step. A page loads without a key and calls the API with the `?key=` from its own URL.

- **Home** (`/`) says what tower is and lists trunks with their counts, plus a link to the public demo trunk. **Needs review** counts the changes waiting in each trunk's inbox (`review` in `GET /repos` counts) and stands out when it isn't zero.
- **Dashboard** (`/repos/<repo>/dashboard?key=…`) has two views. **Operator**, the default, lists in-flight plans (agent, task, claims, coverage, fork, running time), what each holding plan waits on, held amendments, deadlock refusals, lands with their evidence, and an event feed backfilled from the event log. **Map** (`?view=map`, for demos) draws trunk as a treemap with each in-flight agent as a colored dot over the region it claims. The header counts conflicts prevented, drift blocked, deadlocks prevented, landed, forced broad claims and plans blocked by a broad claim. A strip below it charts lands per minute, queue depth and agents in flight over the last 10 minutes. With hundreds of plans, the page draws events at most once per frame, shows the oldest 40 rows of each list, and summarizes holding plans as one line per contested path. **Replay** plays the trunk's event log back at 1 to 64 times speed. **Save log** downloads the log, and **Load log** replays a saved file, so you can show a run after its trunk is gone.
- **Plans** (`/repos/<repo>/plans`) lists every plan in the event log, newest first, filtered by status. Each plan has a shareable page at `/repos/<repo>/plans/<id>` that does the job of a pull request. The page shows the task (as markdown), the status and the time spent in each state, the claims and each amendment, the lifecycle from the event log, and the paths touched so far while the plan is in flight. Once the plan lands, the page also shows the trunk SHA, a diff of every changed file, the risk score and the evidence. Agents polling the same URL get JSON, because tower serves the page only for requests that ask for HTML.
- **Code explorer** (`/repos/<repo>/code`) shows trunk HEAD's file tree with a badge on every path an active plan claims, the open file's contents, and every land that touched it.
- **Inbox** (`/repos/<repo>/inbox`) lists the changes waiting for a human, one card per group, riskiest first. Each card shows the group's risk score and reasons, and each plan's agent, task (linking to its plan page for the diff and evidence), summary and paths. Approve, reject or send back a whole group with a click or from the keyboard: `j`/`k` move, `a` approves, `r` and `s` ask for a note for the agent first, `o` opens the plan. The header counts changes that landed on their own against those that needed a human. On every page of a trunk, the nav's **Inbox** link carries a badge with the number of changes waiting for a human. Like plan pages, tower serves the page only to requests that ask for HTML, so `GET /inbox` still returns JSON to API clients.

`web/client.js` holds the nav and the shared helpers (`api()`, `live()`, `el()`, `color()`, `ago()`). `web/model.js`, `web/plan-model.js` and `web/inbox-model.js` are DOM-free models of the dashboard, the plan pages and the inbox, unit-tested in Node. To add a page, add `web/<page>.html` and a nav entry in `web/client.js`. The page is then served at `/repos/:repo/<page>`. `npm run typecheck` also checks `web/` through JSDoc types (`web/tsconfig.json`).

## Agents: MCP

Any agent that speaks MCP can coordinate through tower, and anything else can use the HTTP API. Each trunk has an MCP endpoint at `/repos/:repo/mcp` (Streamable HTTP, same bearer key). Its tools are `suggest_claims`, `file_plan`, `wait_for_clearance`, `amend_claims`, `check`, `land`, `release`, `why` and `state`. The server's instructions teach the protocol, so the agent's prompt needs only the task and the repo name. Agents use plain `git` with the fork remote and token that `wait_for_clearance` returns.

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

Claude Code (Haiku) and opencode (Gemini 3.5 Flash) have run together on one trunk. Both planned, cloned their forks, landed with evidence, and stayed inside their claims.

## Swarm

`npm run swarm` starts one agent per task, all coordinating through one trunk. The swarm does no coordination itself. It builds each agent's prompt and MCP config, starts agents from `swarm/agents.json` (argv templates for `claude` and `opencode`, so you can add any agent with MCP support), waits, reports what landed, and releases plans that unfinished agents left behind.

```sh
TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... \
	npm run swarm -- --repo tower-src --init --pr --issues 11,12 --task "Fix the typo in README.md"
```

- By default, the swarm starts more of the agent that launched it, found by matching ancestor processes against each agent's `detect` entry. `--agent claude,opencode` picks agents explicitly and deals tasks out in turn.
- `--issues` takes GitHub issue numbers, and `--task` adds a free-text task (repeatable).
- `--init` creates the trunk from the current directory's HEAD.
- `--pr` fetches what landed into a `swarm/<timestamp>` branch and runs the `typecheck` and `test` npm scripts on the combined result. Each agent checks only its own change, so this is where a clash between disjoint claims shows up. `--checks "<cmd>"` replaces the npm scripts. The swarm then pushes the branch, opens a GitHub PR with each agent's evidence, the check results and `Closes #N` for landed issues, and tears the trunk down, so the next run starts fresh from `main`.
- `--timeout` (minutes, default 30) counts from when tower first clears the agent's plan, so time spent waiting in line doesn't count. An agent that is never cleared stops at three times the timeout. While an agent runs, the swarm sends heartbeats for its plans.
- Agents run on their CLI's own default model. `--cheap` picks each agent's `cheap` model from `swarm/agents.json` (Haiku for Claude Code, Gemini Flash for opencode), for test and demo runs. `--model sonnet` sets the model for every agent, and `--model claude=opus,opencode=<model>` sets it per agent. `--model` wins over `--cheap`.
- `--dry-run` prints the agent commands without running anything. Logs go to `swarm-logs/`.

`AGENTS.md` tells agents that work in this repo to send multi-issue requests to the swarm.

## Running it

You need Node 20 or later, `git`, a Cloudflare account on Workers Paid with Artifacts enabled, and Wrangler logged in with the `artifacts:write` scope (`npx wrangler login`).

There are two environments, each with its own Worker, Artifacts namespace and Tower state:

| Environment | Worker | Namespace | Use |
| --- | --- | --- | --- |
| `dev` | `tower-dev` | `tower-dev` | Testing and sims. Wipe it freely. `npm run dev` uses it too. |
| production | `tower` | `tower` | Recorded demo runs only |

```sh
npm install
cp .dev.vars.example .dev.vars   # set TOWER_API_KEY, and optionally TOWER_DASHBOARD_KEY
npm run dev                      # local Worker; Artifacts is always remote (tower-dev namespace)

# In another terminal: seed a trunk, run 8 agents over 4 modules (one drifts), then tear it all down
TOWER_API_KEY=... npm run sim -- --repo sim1 --seed --agents 8 --modules 4 --drift 1
```

With `--seed`, the sim deletes everything it created when it ends: the trunk, the forks and the Tower state. Pass `--keep` to inspect the trunk afterwards, and run `curl -X DELETE …/repos/<repo>` to remove it later.

The sim's agents always pass their checks and only touch module files, so every land is low risk. To fill the inbox without LLM agents, pass `--review <n>`. The last n agents each change a sensitive file of their own, and `--seed` puts those files on trunk: auth files under `src/auth/`, one CI workflow under `.github/workflows/`, and one module file whose checks report a failure. Their lands answer 202 and wait in the inbox in up to three groups, while the rest land as usual. The summary reports `review` (how many went to review) and `reviewGroups` (how many per group). The conflict check and teardown still pass, and without `--keep` the teardown deletes the review plans' forks too.

```sh
# Leaves 3 changes in GET /repos/review-demo/inbox (auth, CI config, failing checks); the other 5 land
TOWER_API_KEY=... npm run sim -- --repo review-demo --seed --keep --review 3
```

### Demo: plain Git, tower, and real agents

`--plain` runs the same workload (same `--agents`, `--modules`, `--zipf`, `--rng` and `--stagger`) against a local bare repo with no tower, and needs no key. Each agent does what an uncoordinated agent does on a shared repo: clone, edit, commit, push. A rejected push pulls with rebase, and a rebase that conflicts is thrown away and the edit redone on the new trunk. The run reports `rejectedPushes` and `mergeConflicts` (each conflict is an edit redone), then checks the content the same way as `--seed`. Everyone gets there in the end, but every conflict is work done twice. On tower the same workload reports `conflictsPrevented` instead, because agents wait for their claim. 8 agents over 4 modules gave 11 merge conflicts and 28 rejected pushes, and 30 agents gave 152 and 298. `--keep` keeps the bare repo and prints its path.

```sh
npm run sim -- --plain --agents 30 --modules 4    # no tower, no key: count the merge conflicts
```

The seed commit is a small Worker app: `package.json`, `wrangler.jsonc` (named `tower-demo-<repo>`), one `src/modules/m<k>.ts` per module, and `src/index.ts`, which serves a page listing the agents in each module. To watch it fill in, run the sim with `--keep` once, then connect the trunk in the Cloudflare dashboard under **Workers & Pages > Create application > Continue with Artifacts**, picking the tower namespace and the trunk repo, with `main` as the production branch. Every later land redeploys the page. Forks are separate repos, not branches of trunk, so Workers Builds preview URLs don't apply to them.

`--llm "<task>"` (repeatable) mixes real agents into a tower run. After seeding, the sim starts `swarm/swarm.mjs --agent claude` with one Claude Code agent per task on the same trunk, then starts the scripted agents. `--model` is passed through to the swarm, which otherwise uses its cheap default. Swarm output is prefixed `llm`, and the agents' own logs go to `swarm-logs/`. The sim waits for the swarm before it reports, verifies and tears down. It reports how many real agents landed as `llmLanded`, and the swarm's exit code as `llmExit`, failing if that is nonzero. Ctrl-C stops the swarm and its agents and still tears down, and a second Ctrl-C exits at once. Real agents take minutes, so spread the scripted agents with `--stagger` over a few minutes to have both in flight together. A task that edits a hot module (`m0`) makes tower hold scripted agents behind a real one.

```sh
TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... npm run sim -- --repo demo --seed \
	--agents 20 --modules 4 --stagger 240 --llm "Add a GET /health route to src/index.ts that returns ok"
```

Tests:

```sh
npm run typecheck          # TypeScript, including web/ through JSDoc
npm test                   # unit tests in Node, and Durable Object tests in workerd with a fake Artifacts binding
npm run test:integration   # the sim against tower-dev; needs TOWER_API_KEY and wrangler login, and spends Artifacts operations
```

`npm test` needs no Cloudflare account. CI runs typecheck and `npm test` on every push.

Deploy:

```sh
npm run deploy:dev && npx wrangler secret put TOWER_API_KEY --env dev   # https://tower-dev.<subdomain>.workers.dev
npm run deploy     && npx wrangler secret put TOWER_API_KEY             # https://tower.<subdomain>.workers.dev
```

Set `TOWER_DASHBOARD_KEY` the same way if you want a read-only dashboard URL. Set the `TOWER_DEMO_REPO` variable to make one trunk watchable without a key.

Cost: Artifacts bills operations and storage. Workers Paid includes 10,000 operations and 1 GB a month. Repos persist until deleted, so tower deletes forks when plans close, and the sim deletes its trunks.

## Scale

`npm run sim` drives hundreds of scripted agents through the full loop: file, wait, clone the fork, commit, push and land. Each agent picks one of `--modules` files from a Zipf distribution (`--zipf 1`), so `m0` is the hottest and the tail is quiet. Starts are spread over `--stagger` seconds, and at most `--git` (default 24) git commands run at a time. When the run ends, the sim replays the event log and prints throughput. With `--seed`, it then clones trunk and checks for conflicts: every module must hold exactly the lines of the agents that picked it, and trunk must have exactly one commit per land. `--out run.json` saves the metrics and the full event log, and the dashboard's **Load log** replays the file.

```sh
TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... \
	npm run sim -- --repo scale --seed --agents 500 --modules 50 --stagger 30 --quiet --out scale.json
```

| Metric | Meaning |
| --- | --- |
| plans/min, lands/min | Filed and landed plans over the run, plus the busiest minute of lands |
| time holding p50/p95 | From filing to clearance, read from the event log |
| land latency p50/p95 | Client-side time for `POST …/land` |
| max queue depth / in flight / active | The most plans holding, cleared, and both at once |
| `artifactsCalls` | Calls tower made into the Artifacts binding (`stats.artifacts_calls`), an upper bound on billed operations. Add the sim's own git clones and pushes. |
| conflicts | Modules whose content on trunk isn't exactly what their agents wrote |
| review, reviewGroups | Lands that answered 202 and wait in the inbox (`--review`), in total and per group |

**Recorded run (2026-10-06): 250 agents, 0 conflicts.** The run used `npm run sim -- --repo scale28-r250 --seed --agents 250 --modules 50 --stagger 20 --quiet` against the deployed `tower-dev` Worker, before the landing changes below were deployed. All 250 agents filed within 20 seconds, and up to 246 plans were active at once. The hottest module, `m0`, drew 51 agents, then `m1` drew 33 and `m2` drew 17. Every agent landed. Trunk ended with exactly one commit per land, and every module held exactly its agents' lines.

| | |
| --- | --- |
| agents · modules · duration | 250 · 50 (Zipf 1) · 14 min 22 s |
| plans/min · lands/min (busiest minute) | 17.4 · 17.4 (25) |
| time holding p50 / p95 | 5 min 4 s / 12 min 5 s |
| land latency p50 / p95 | 31.3 s / 114.5 s |
| max queue depth · max in flight · max active | 202 · 44 · 246 |
| conflicts prevented · conflicts on trunk · failed agents | 206 · 0 · 0 |
| events logged | 3,795, of which 2,339 were repeated `holding` announcements |
| Artifacts | About 10 tower calls per agent (123 for 12 agents, metered locally), plus 251 git pushes and 251 clones from the sim, counting the seed push and the verification clone. That is about 3,100 operations, or about $0.45 beyond the included 10,000. |

The run exposed these bottlenecks:

- **Landing one at a time is the ceiling.** Lands arrived every 2.6 s at p50, so landing topped out at about 20 to 25 a minute however many agents were ready. With 44 agents holding forks, a land waited up to two minutes for the lock. The lock used to cover the fork diff, risk scoring with a full trunk walk, trunk `log` and `info`, creating and revoking a token, the push, and deleting the fork. Now it covers only scoring from caches and the push. With 12 agents on one module (`wrangler dev` against `tower-dev` Artifacts), time inside the lock per land fell from a median of 8.7 s (7.0 to 10.7 s) to 2.7 s (2.4 to 4.2 s), and land latency p50 fell from 8.3 s to 4.9 s. Those local timings include round trips from a laptop to Artifacts, so deployed times are lower in both cases.
- **Broadcasts grew with the square of the queue.** Each land announced every plan queued behind it again, because each one's `blockedBy` got shorter. Now tower announces a queued plan again only when it waits on someone new, and the dashboard works out who is ahead. The same 12-agent run logs 82 events instead of 137, and a queue of N plans costs N `holding` events instead of about N²/2. Closing a plan also re-checks only the plans that waited on it, against one parsed copy of the active plans.
- **Fork creation kept up.** From cleared to provisioned took 3.6 s at p50, 4.7 s at p95, and 7.7 s at most. `/state` stayed small at 93 KB with 239 active plans, answered in 0.2 s.
- **The dashboard stayed readable.** Replaying this run's log at 64 times speed drew no frame slower than 17 ms.

The landing changes are deployed to `tower-dev` but not yet measured there at this scale. To measure them, run the command above with `--out run.json` when no swarm is using `tower-dev`. Its `artifactsCalls` line then comes from tower itself.

## Roadmap

- [x] Live dashboard with a codebase map, agents as dots, and a "conflicts prevented" counter
- [x] Review by exception: score each land, land low-risk changes at once, send the rest to a human inbox
- [x] Lease expiry for crashed or silent agents
- [x] Claim hygiene: refuse broad claims, warn on guessed paths, suggest real ones
- [ ] An inbox page for deciding reviews (#29)
- [ ] Dependent plans, "B after A", instead of stacked PRs (#30)
- [ ] More agents in the swarm: Codex, Gemini CLI, Cursor, Aider (#17)
- [ ] Hosted dispatch: tower starts agents in Cloudflare Sandboxes on request (#16)
- [ ] Symbol-level claims from a tree-sitter planning pass
- [ ] Optional tournament mode for contested tasks

## License

MIT
