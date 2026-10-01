// What the dashboard sees: live events over WebSockets, counters, and the state snapshot.

import { ACTIVE, type Core, getMeta, type PlanRow, toPlan } from "./core";

export function broadcast(t: Core, event: object) {
	const msg = JSON.stringify({ ...event, at: Date.now() });
	for (const ws of t.ctx.getWebSockets()) {
		try {
			ws.send(msg);
		} catch {}
	}
}

export function bump(t: Core, key: string) {
	t.sql.exec("INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET value = value + 1", key);
	broadcast(t, { type: "stat", key });
}

export function state(t: Core) {
	const plans = t.sql
		.exec<PlanRow>(`SELECT * FROM plans WHERE status IN ${ACTIVE} ORDER BY created_at`)
		.toArray()
		.map(toPlan);
	const lands = t.sql
		.exec<{ sha: string; evidence: string }>("SELECT sha, plan_id, agent, task, summary, evidence, landed_at FROM lands ORDER BY landed_at DESC LIMIT 50")
		.toArray()
		.map((r) => ({ ...r, evidence: JSON.parse(r.evidence), paths: landPaths(t, r.sha) }));
	const stats = Object.fromEntries(t.sql.exec<{ key: string; value: number }>("SELECT * FROM stats").toArray().map((r) => [r.key, r.value]));
	return { repo: getMeta(t, "repo"), plans, lands, stats };
}

function landPaths(t: Core, sha: string): string[] {
	return t.sql.exec<{ path: string }>("SELECT path FROM land_paths WHERE sha = ?", sha).toArray().map((r) => r.path);
}

export function live(t: Core): Response {
	const [client, server] = Object.values(new WebSocketPair());
	t.ctx.acceptWebSocket(server);
	server.send(JSON.stringify({ type: "state", state: state(t) }));
	return new Response(null, { status: 101, webSocket: client });
}
