# tower

Air traffic control for agents working on Git, built on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/).

Plain Git finds out about conflicts at merge time, after the work is done. With hundreds of agents that's backwards. In `tower`, an agent files a **flight plan** (its task and the paths it will touch) before it starts. The tower sequences overlapping plans, gives each cleared agent its own fork and a fork-scoped token, and lands each change onto trunk itself. Trunk never sees a textual merge conflict, and every landed commit remembers why it was made.

## Architecture

```
                         ┌──────────────── Worker (src/index.ts) ─────────────────┐
  agents / dashboard ──▶ │  /repos/:repo/*  ──auth──▶  TOWER.getByName(repo)      │
                         └────────────────────────────────┬───────────────────────┘
                                                          ▼
          ┌────────────── Tower Durable Object, one per trunk (src/tower.ts) ────────────┐
          │ SQLite: plans · lands · land_paths · stats      WebSocket broadcast (/live)  │
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

**Leases.** A claim is a file (`src/auth/session.ts`) or a directory (`src/auth/` or `src/auth/**`). Two claims overlap when one equals or contains the other. A new plan waits behind every cleared plan it overlaps, and behind every earlier holding plan it overlaps, so the queue is FIFO and nothing jumps ahead. Symbol-level claims, from a tree-sitter planning pass, are planned as a finer-grained layer on the same model.

**Isolation.** Every cleared plan gets its own Artifacts fork and short-lived write tokens scoped to that fork. Agents never hold trunk credentials. When the plan lands or is released, the fork is deleted. A landed fork's changes live on trunk, and its name stays in the commit's `Tower-Fork` trailer.

**Drift and the merge gate.** The tower diffs the fork's HEAD tree against the commit it forked from, using only the binding's `readCommit` and `readTree`. It descends only into subtrees whose hash changed. Any changed path outside the lease is drift: `POST …/check` reports it, and `POST …/land` refuses it with a 409. This needs no push-event subscription per fork. (Push events are subscribed per repo, so they're an optional live feed and not part of the core loop.)

**Landing.** The binding can read Git objects but can't write them. So the tower keeps an in-memory isomorphic-git workspace of trunk. To land, it copies the fork's changed blobs into the workspace, rewrites only the trees on the changed paths, commits on top of trunk HEAD, and pushes. Landing is serialized inside the Durable Object, and the tower is trunk's only writer. Because leases are disjoint, the overlay is conflict-free by construction. Semantic conflicts are a different problem; review-by-exception is meant to handle those.

**Memory.** Each landed commit carries `Tower-Plan`, `Tower-Agent` and `Tower-Fork` trailers. The agent's evidence (prompt, plan, test results, and so on) is stored against the trunk SHA. `GET …/why?path=` answers why a path looks the way it does, not just who changed it last.

## API

All routes are under `/repos/:repo` and require `Authorization: Bearer $TOWER_API_KEY`. The WebSocket route also accepts `?key=`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/init` `{importUrl?}` | Create or import trunk. Returns a seeding token. |
| DELETE | `/` | Tear down a trunk: delete it and any remaining forks, and reset the Tower's state. |
| POST | `/plans` `{agent, task, claims[]}` | File a flight plan. Returns `holding` or `cleared`, plus fork credentials if cleared. |
| GET | `/plans/:id` | Poll a plan. Once cleared, returns the fork remote and a fresh fork token. |
| POST | `/plans/:id/check` | Report touched paths and drift so far. |
| POST | `/plans/:id/land` `{summary?, evidence?}` | Merge gate: land onto trunk, or 409 with the drifted paths. |
| POST | `/plans/:id/release` | Abandon a plan and free its airspace. |
| GET | `/state` | Active plans, recent lands, stats. |
| GET | `/why?path=` | Landed changes (with evidence) that touched a path. |
| GET | `/live` (WebSocket) | Live plan, drift, land and stat events for the dashboard. |

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

## Roadmap

- [ ] Live dashboard: a codebase map with agents as dots claiming regions, and a "conflicts prevented" counter
- [ ] Review by exception: score each land by risk, auto-land low-risk changes, and send the rest to a small human inbox
- [ ] Symbol-level claims with a tree-sitter planning pass
- [ ] Real LLM agents alongside scripted ones; a demo repo that's a Worker app, so Workers Builds gives every fork a preview URL
- [ ] Optional: tournament mode for contested tasks

## License

MIT
