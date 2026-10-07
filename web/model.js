// @ts-check
// The dashboard's model, with no DOM: what the live feed, the state snapshot, the event log
// and a replay all reduce into, so every view and every source tells the same story. Also the
// agent colors and short names. Pure, so test/unit/dashboard-model.test.ts runs it in Node.

/** @typedef {{ path: string, dir: boolean }} Claim */
/** @typedef {{ claims: Claim[], blockedBy: string[], requestedAt: number }} Amendment */
/** @typedef {{ id: string, agent: string, task: string, status: string, claims: Claim[], blockedBy: string[], amendment?: Amendment | null, fork?: string | null, base?: string | null, createdAt: number }} Plan */
/** @typedef {{ sha: string, planId: string, agent: string, task: string, summary: string, paths: string[], at: number, evidence?: unknown }} Land */
/** @typedef {{ seq: number, at: number, kind: "info" | "land" | "drift" | "held", agent: string, text: string, paths: string[] }} FeedEntry */
/** @typedef {{ at: number, paths: string[], cycle: string[] }} Deadlock */
/** @typedef {{ plan: Plan, paths: string[] }} Wait */
/** @typedef {{ files: number, share: number, trunk: number }} Coverage */
/** @typedef {{ coverage: Coverage | null, forced: string[] }} Hygiene what a plan's claims cover of trunk, and the broad paths it forced */
/**
 * @typedef {{
 *   plans: Record<string, Plan>,
 *   names: Record<string, string>,
 *   lands: Land[],
 *   stats: Record<string, number>,
 *   feed: FeedEntry[],
 *   deadlocks: Record<string, Deadlock>,
 *   hygiene: Record<string, Hygiene>,
 *   clearedAt: Record<string, number>,
 *   seq: number,
 * }} Model
 */

export const FEED_MAX = 300;

/** @returns {Model} */
export function createModel() {
	return { plans: {}, names: {}, lands: [], stats: {}, feed: [], deadlocks: {}, hygiene: {}, clearedAt: {}, seq: 0 };
}

// ── colors ─────────────────────────────────────────────────────────────────

/** Well-separated hues, handed out in the order agents are first seen. */
export const PALETTE = [
	"hsl(210, 85%, 62%)", // blue
	"hsl(32, 95%, 58%)", // orange
	"hsl(140, 60%, 52%)", // green
	"hsl(330, 80%, 66%)", // pink
	"hsl(50, 90%, 58%)", // yellow
	"hsl(270, 70%, 70%)", // violet
	"hsl(180, 70%, 50%)", // teal
	"hsl(0, 80%, 64%)", // red
	"hsl(95, 65%, 55%)", // lime
	"hsl(240, 60%, 72%)", // periwinkle
];

/** @type {Map<string, string>} agent -> color, kept for the whole session (across resets and replays) */
const assigned = new Map();

/** A color per agent: the next palette entry on first sight, then a hash spread by the golden angle. */
export function color(/** @type {string} */ agent) {
	let c = assigned.get(agent);
	if (c) return c;
	if (assigned.size < PALETTE.length) c = PALETTE[assigned.size];
	else {
		let h = 0;
		for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
		c = "hsl(" + ((h * 137.508) % 360).toFixed(1) + ", 75%, " + (55 + (h % 3) * 7) + "%)";
	}
	assigned.set(agent, c);
	return c;
}

/** The same color with an alpha, for tints. */
export function tint(/** @type {string} */ c, /** @type {number} */ alpha) {
	return c.replace("hsl(", "hsla(").replace(")", ", " + alpha + ")");
}

/** Forget every assignment (tests only). */
export function resetColors() { assigned.clear(); }

/**
 * A short label that still tells agents apart: "claude-issue-21" -> "21", "sim-7" -> "7",
 * "alice" -> "alice". Initials would make every swarm agent "ci".
 */
export function shortName(/** @type {string} */ agent) {
	const parts = agent.split(/[-_.\s]+/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : agent;
}

/** "12 files · 3% of trunk", with "<1%" rather than a misleading 0%. @param {Coverage} c */
export function coverageText(c) {
	const pct = c.share > 0 && c.share < 0.01 ? "<1%" : Math.round(c.share * 100) + "%";
	return c.files + (c.files === 1 ? " file" : " files") + " · " + pct + " of trunk";
}

/** The first line of a task. */
export function firstLine(/** @type {string} */ text) { return (text || "").split("\n")[0]; }

// ── who waits on whom ──────────────────────────────────────────────────────

/** @param {Claim} a @param {Claim} b */
export function overlaps(a, b) {
	if (a.path === b.path) return true;
	if (a.dir && b.path.startsWith(a.path)) return true;
	if (b.dir && a.path.startsWith(b.path)) return true;
	return false;
}

/** @param {Plan} p */
export function active(p) { return p.status === "cleared" || p.status === "holding"; }

/**
 * Which active plans block `claims`, and on which paths, recomputed as the Tower does: every
 * cleared plan, plus holding plans filed before `before` (pass 0 for an amendment, which only
 * cleared plans block). A plan's stored blockedBy can go stale, so this is what to show.
 * @param {Claim[]} claims @param {string} self @param {number} before @param {Plan[]} all
 * @returns {Wait[]}
 */
export function waitsOn(claims, self, before, all) {
	/** @type {Wait[]} */
	const out = [];
	all.filter(active).forEach((q) => {
		if (q.id === self || !(q.status === "cleared" || q.createdAt < before)) return;
		/** @type {string[]} */
		const paths = [];
		q.claims.forEach((a) => claims.forEach((b) => {
			if (!overlaps(a, b)) return;
			const p = a.path.length >= b.path.length ? a.path : b.path; // the narrower of the two
			if (!paths.includes(p)) paths.push(p);
		}));
		if (paths.length) out.push({ plan: q, paths });
	});
	return out;
}

/** What a holding plan waits on. @param {Plan} p @param {Plan[]} all */
export function holdingOn(p, all) { return waitsOn(p.claims, p.id, p.createdAt, all); }

/** What a cleared plan's held amendment waits on. @param {Plan} p @param {Plan[]} all */
export function amendmentOn(p, all) { return p.amendment ? waitsOn(p.amendment.claims, p.id, 0, all) : []; }

/** Whether a holding plan waits on a plan that forced a broad claim. @param {Model} m @param {Plan} p @param {Plan[]} all */
export function behindBroad(m, p, all) { return holdingOn(p, all).some((w) => (m.hygiene[w.plan.id]?.forced.length || 0) > 0); }

/** Active plans, oldest first. @param {Model} m */
export function activePlans(m) {
	return Object.values(m.plans).filter(active).sort((a, b) => a.createdAt - b.createdAt);
}

// ── reducing events ────────────────────────────────────────────────────────

/** @param {Model} m @param {string | null | undefined} id */
export function agentOf(m, id) { return id ? m.names[id] || m.plans[id]?.agent || id : "?"; }

/**
 * Replaces the model's plans, lands and stats with a /state snapshot. The feed, deadlocks,
 * claim coverage and clear times come from the event log, so they are kept.
 * @param {Model} m @param {any} state
 */
export function applyState(m, state) {
	m.plans = {};
	(state.plans || []).forEach(/** @param {Plan} p */ (p) => { m.plans[p.id] = p; m.names[p.id] = p.agent; });
	m.lands = (state.lands || []).slice().reverse().map(toLand);
	m.lands.forEach((l) => { m.names[l.planId] = l.agent; });
	// Colors are handed out in model order (plans by age, then lands oldest first), not render
	// order, so both views give an agent the same color.
	Object.values(m.plans).sort((a, b) => a.createdAt - b.createdAt).forEach((p) => { color(p.agent); });
	m.lands.forEach((l) => { color(l.agent); });
	m.stats = Object.assign({}, state.stats);
	if (typeof state.seq === "number") m.seq = state.seq;
}

/** A /state or /why land row as the model keeps it. @param {any} l @returns {Land} */
export function toLand(l) {
	return { sha: l.sha, planId: l.plan_id, agent: l.agent, task: l.task || "", summary: l.summary, paths: l.paths || [], at: l.landed_at, evidence: l.evidence };
}

/**
 * Records what an event says happened (feed entry, deadlock, coverage, clear time) without touching
 * plans, lands or stats. Used alone to backfill history older than a snapshot.
 * @param {Model} m @param {any} ev
 */
export function remember(m, ev) {
	const id = ev.planId || ev.plan?.id;
	if (id && (ev.agent || ev.plan?.agent)) m.names[id] = ev.agent || ev.plan.agent;
	if (ev.type === "cleared" && id) m.clearedAt[id] = ev.at;
	if (ev.type === "deadlock" && id) m.deadlocks[id] = { at: ev.at, paths: ev.paths || [], cycle: ev.cycle || [] };
	if ((ev.type === "amended" || ev.type === "landed" || ev.type === "released") && id) delete m.deadlocks[id];
	// Only filed and granted-amendment events measure claims; /state plans don't carry it.
	if ((ev.type === "filed" || ev.type === "amended") && id && (ev.coverage || ev.forced)) {
		const h = m.hygiene[id] || (m.hygiene[id] = { coverage: null, forced: [] });
		if (ev.coverage) h.coverage = { files: ev.coverage.files, share: ev.coverage.share, trunk: ev.coverage.trunk };
		(ev.forced || []).forEach(/** @param {string} p */ (p) => { if (!h.forced.includes(p)) h.forced.push(p); });
	}
	const entry = describe(m, ev);
	if (!entry) return;
	if (m.feed.some((e) => e.seq === entry.seq && entry.seq > 0)) return;
	m.feed.push(entry);
	m.feed.sort((a, b) => a.seq - b.seq || a.at - b.at);
	if (m.feed.length > FEED_MAX) m.feed.splice(0, m.feed.length - FEED_MAX);
}

/**
 * Applies a live (or replayed) event to the model. Returns the new land for a "landed" event.
 * @param {Model} m @param {any} ev
 * @returns {Land | null}
 */
export function apply(m, ev) {
	if (ev.type === "state") { applyState(m, ev.state); return null; }
	if (ev.type === "reset") {
		Object.assign(m, createModel());
		return null;
	}
	if (typeof ev.seq === "number") m.seq = Math.max(m.seq, ev.seq);
	remember(m, ev);
	const agent = ev.agent || ev.plan?.agent;
	if (agent) color(agent);
	if (ev.type === "stat") m.stats[ev.key] = (m.stats[ev.key] || 0) + 1;
	if (ev.plan) {
		/** @type {Plan} */
		const plan = ev.plan;
		m.plans[plan.id] = plan;
		if (ev.type === "landed") {
			/** @type {Land} */
			const land = { sha: ev.sha, planId: plan.id, agent: plan.agent, task: plan.task, summary: ev.summary || firstLine(plan.task), paths: ev.paths || [], at: ev.at };
			if (!m.lands.some((l) => l.sha === land.sha)) m.lands.push(land);
			return land;
		}
	}
	return null;
}

/**
 * The feed line for an event, or null for events that only move counters.
 * @param {Model} m @param {any} ev
 * @returns {FeedEntry | null}
 */
export function describe(m, ev) {
	const id = ev.planId || ev.plan?.id;
	const agent = ev.agent || ev.plan?.agent || agentOf(m, id);
	const names = (/** @type {string[]} */ ids) => (ids || []).map((x) => agentOf(m, x)).join(", ");
	/** @param {FeedEntry["kind"]} kind @param {string} text @param {string[]} [paths] @returns {FeedEntry} */
	const entry = (kind, text, paths) => ({ seq: ev.seq || 0, at: ev.at || 0, kind, agent, text, paths: paths || [] });
	switch (ev.type) {
		case "filed":
			if (ev.forced?.length) return entry("drift", "filed with a forced broad claim: " + firstLine(ev.plan?.task || ""), ev.forced);
			return entry("info", "filed: " + firstLine(ev.plan?.task || ""), (ev.plan?.claims || []).map(/** @param {Claim} c */ (c) => c.path));
		case "holding": return entry("held", "holding behind " + (names(ev.blockedBy) || "earlier plans"));
		case "cleared": return entry("info", "cleared for takeoff");
		case "provisioned": return entry("info", "got fork " + (ev.fork || ""));
		case "amended": return ev.forced?.length ? entry("drift", "amended with a forced broad claim", ev.forced) : entry("info", "amended claims", ev.added);
		case "amendment_held": return entry("held", "amendment held behind " + names(ev.blockedBy), ev.paths);
		case "deadlock": return entry("drift", "amendment refused (deadlock " + names(ev.cycle).replace(/, /g, " → ") + ")", ev.paths);
		case "drift": return entry("drift", ev.blocked ? "land rejected: changes outside claims" : "check found changes outside claims", ev.paths);
		case "landed": return entry("land", "landed " + String(ev.sha || "").slice(0, 7) + ": " + (ev.summary || ""), ev.paths);
		case "released": return entry("info", "released its plan");
		default: return null;
	}
}

// ── replay ─────────────────────────────────────────────────────────────────

/**
 * Delays between replayed events: real gaps, capped so idle stretches don't stall the show,
 * and divided by the speed.
 * @param {{ at: number }[]} events @param {number} speed @param {number} [cap]
 */
export function replayDelays(events, speed, cap = 2000) {
	return events.map((e, i) => (i === 0 ? 0 : Math.max(20, Math.min(cap, Math.max(0, e.at - events[i - 1].at)) / speed)));
}
