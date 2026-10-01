// What the dashboard sees: the persisted event log, live events over WebSockets, counters,
// and the state snapshot. Every event goes through emit(), which appends it to the events
// table and then broadcasts it with its seq, so history (GET /events) and the live feed
// (/live, /live?since=) are the same stream.

import { ACTIVE, type Core, getMeta, plan as getPlan, type PlanRow, toPlan } from "./core";

// Events kept per trunk; older ones are pruned as new ones arrive.
export const KEEP_EVENTS = 50_000;
const PAGE_DEFAULT = 1000;
const PAGE_MAX = 10_000;

export type Event = { seq: number; at: number; type: string; planId: string | null; agent: string | null; [key: string]: unknown };

type EventRow = { seq: number; at: number; type: string; plan_id: string | null; agent: string | null; data: string };

export function emit(t: Core, type: string, event: { planId?: string; agent?: string; [key: string]: unknown } = {}) {
	const { planId = null, agent = null, ...data } = event;
	const at = Date.now();
	const { seq } = t.sql
		.exec<{ seq: number }>(
			"INSERT INTO events (at, type, plan_id, agent, data) VALUES (?, ?, ?, ?, ?) RETURNING seq",
			at, type, planId, agent, JSON.stringify(data),
		)
		.one();
	if (seq % 1000 === 0) t.sql.exec("DELETE FROM events WHERE seq <= ?", seq - KEEP_EVENTS);
	send(t, { ...data, seq, at, type, planId, agent });
}

// A plan lifecycle event (filed, holding, cleared, provisioned, amended, landed, released...)
// carries the plan as it now stands, so a client can update its view from the event alone.
export function emitPlan(t: Core, type: string, id: string, data: Record<string, unknown> = {}) {
	const plan = getPlan(t, id);
	emit(t, type, { ...data, planId: plan.id, agent: plan.agent, plan });
}

function send(t: Core, msg: object) {
	const text = JSON.stringify(msg);
	for (const ws of t.ctx.getWebSockets()) {
		try {
			ws.send(text);
		} catch {}
	}
}

// Not persisted: it announces that the log itself (with everything else) is gone.
export function reset(t: Core) {
	send(t, { type: "reset", at: Date.now() });
}

export function bump(t: Core, key: string) {
	t.sql.exec("INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET value = value + 1", key);
	emit(t, "stat", { key });
}

// History in seq order: events after `since`, optionally for one plan, a page at a time.
// `last` is the seq to pass as the next `since`.
export function events(t: Core, q: { since?: string | null; plan?: string | null; limit?: string | null }) {
	const since = Number(q.since) || 0;
	const limit = Math.min(Math.max(Number(q.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
	const rows = q.plan
		? t.sql.exec<EventRow>("SELECT * FROM events WHERE seq > ? AND plan_id = ? ORDER BY seq LIMIT ?", since, q.plan, limit)
		: t.sql.exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", since, limit);
	const list = rows.toArray().map(toEvent);
	return { events: list, last: list.at(-1)?.seq ?? since };
}

function toEvent(r: EventRow): Event {
	return { ...JSON.parse(r.data), seq: r.seq, at: r.at, type: r.type, planId: r.plan_id, agent: r.agent };
}

function lastSeq(t: Core): number {
	return t.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events").one().seq ?? 0;
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
	return { repo: getMeta(t, "repo"), seq: lastSeq(t), plans, lands, stats };
}

function landPaths(t: Core, sha: string): string[] {
	return t.sql.exec<{ path: string }>("SELECT path FROM land_paths WHERE sha = ?", sha).toArray().map((r) => r.path);
}

// A new client gets a state snapshot (carrying the latest seq), then live events. A client
// reconnecting with ?since=<seq> instead gets every event it missed, in order, then live
// events, so it catches up without gaps. If those events were pruned, or the trunk was reset
// since (seq restarted), it gets a fresh snapshot instead. Nothing awaits between accepting
// the socket and sending the backlog, so no event can fall between the two.
export function live(t: Core, since: string | null): Response {
	const [client, server] = Object.values(new WebSocketPair());
	t.ctx.acceptWebSocket(server);
	const from = since === null || since === "" ? NaN : Number(since);
	const last = lastSeq(t);
	const oldest = t.sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events").one().seq ?? last + 1;
	if (Number.isInteger(from) && from >= 0 && from <= last && from >= oldest - 1) {
		for (const r of t.sql.exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq", from)) server.send(JSON.stringify(toEvent(r)));
	} else {
		server.send(JSON.stringify({ type: "state", state: state(t) }));
	}
	return new Response(null, { status: 101, webSocket: client });
}
