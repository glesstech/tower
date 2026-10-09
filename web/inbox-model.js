// @ts-check
// The inbox page's model, with no DOM: GET /inbox's groups as cards (riskiest first), which card
// has focus and whether a decision is being written or sent (one state machine, stepped by
// actions), the key table that turns keys into actions, and the one-line outcome of a decision.
// Pure, so test/unit/inbox-model.test.ts runs it in Node.

/** @typedef {"approve" | "reject" | "send_back"} Decision */
/** @typedef {{ score: number, level: string, reasons: string[], group: { key: string, label: string } }} Risk */
/** @typedef {{ id: string, agent: string, task: string, summary: string | null, paths: string[], risk: Risk, requestedAt: number }} Item */
/** @typedef {{ key: string, label: string, count: number, plans: Item[] }} Group */
/** @typedef {{ key: string, label: string, count: number, score: number, reasons: string[], plans: Item[] }} Card */
/**
 * @typedef {{ mode: "browse", focus: string | null }
 *   | { mode: "note", focus: string, decision: "reject" | "send_back", note: string }
 *   | { mode: "deciding", focus: string, decision: Decision }} View
 */
/**
 * @typedef {{ type: "move", by: 1 | -1 } | { type: "focus", key: string } | { type: "approve" }
 *   | { type: "start", decision: "reject" | "send_back" } | { type: "type", note: string }
 *   | { type: "cancel" } | { type: "submit" } | { type: "done" } | { type: "open" }} Action
 */
/** @typedef {{ id: string, outcome: string, reason?: string, error?: string }} Result */

/** Live event types after which the inbox may have changed. */
export const REFETCH = new Set(["review", "sent_back", "landed", "released", "expired", "reset", "state"]);

/**
 * One card per group: its highest score, every reason its plans give (once each), and its
 * plans riskiest first. Cards come riskiest first, then the one waiting longest.
 * @param {Group[]} decisions
 * @returns {Card[]}
 */
export function cards(decisions) {
	const oldest = (/** @type {Item[]} */ plans) => Math.min(...plans.map((p) => p.requestedAt));
	return decisions
		.map((g) => {
			const plans = [...g.plans].sort((a, b) => b.risk.score - a.risk.score || a.requestedAt - b.requestedAt);
			const reasons = [...new Set(plans.flatMap((p) => p.risk.reasons))];
			const score = Math.max(0, ...plans.map((p) => p.risk.score));
			return { key: g.key, label: g.label, count: g.count, score, reasons, plans };
		})
		.sort((a, b) => b.score - a.score || oldest(a.plans) - oldest(b.plans));
}

/**
 * Keys per mode. In browse, letters are shortcuts; in note mode they type into the note, so only
 * Enter and Escape mean anything; while a decision is in flight, no key does.
 * @type {Record<View["mode"], Record<string, Action>>}
 */
export const KEYS = {
	browse: {
		j: { type: "move", by: 1 },
		ArrowDown: { type: "move", by: 1 },
		k: { type: "move", by: -1 },
		ArrowUp: { type: "move", by: -1 },
		a: { type: "approve" },
		r: { type: "start", decision: "reject" },
		s: { type: "start", decision: "send_back" },
		o: { type: "open" },
		Enter: { type: "open" },
		Escape: { type: "cancel" },
	},
	note: {
		Enter: { type: "submit" },
		Escape: { type: "cancel" },
	},
	deciding: {},
};

/** The action a key means in this view, or null. @param {View} view @param {string} key */
export function keyAction(view, key) {
	return Object.hasOwn(KEYS[view.mode], key) ? KEYS[view.mode][key] : null;
}

/**
 * The next view after an action. Approve sends at once; reject and send back first take a
 * note. While a decision is in flight only `done` counts. `open` is the page's to carry out.
 * @param {View} view
 * @param {Action} action
 * @param {Card[]} list
 * @returns {View}
 */
export function step(view, action, list) {
	if (view.mode === "deciding") return action.type === "done" ? { mode: "browse", focus: view.focus } : view;
	if (view.mode === "note") {
		switch (action.type) {
			case "type": return { ...view, note: action.note };
			case "cancel": return { mode: "browse", focus: view.focus };
			case "submit": return { mode: "deciding", focus: view.focus, decision: view.decision };
			default: return view;
		}
	}
	const focus = view.focus !== null && list.some((c) => c.key === view.focus) ? view.focus : null;
	switch (action.type) {
		case "move": {
			if (!list.length) return view;
			const i = list.findIndex((c) => c.key === focus);
			const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + action.by));
			return { mode: "browse", focus: list[next].key };
		}
		case "focus": return list.some((c) => c.key === action.key) ? { mode: "browse", focus: action.key } : view;
		case "approve": return focus === null ? view : { mode: "deciding", focus, decision: "approve" };
		case "start": return focus === null ? view : { mode: "note", focus, decision: action.decision, note: "" };
		default: return view;
	}
}

/**
 * Keeps focus across a refetch: on the same group if it is still waiting, else on the card now
 * at its old place (or the last card), else nothing. A note for a group that is gone is dropped.
 * @param {View} view
 * @param {Card[]} prev
 * @param {Card[]} next
 * @returns {View}
 */
export function refocus(view, prev, next) {
	if (view.focus !== null && next.some((c) => c.key === view.focus)) return view;
	if (!next.length) return { mode: "browse", focus: null };
	const i = Math.max(0, prev.findIndex((c) => c.key === view.focus));
	return { mode: "browse", focus: next[Math.min(i, next.length - 1)].key };
}

const OUTCOMES = /** @type {const} */ ([["landed", "landed"], ["rejected", "rejected"], ["sent_back", "sent back"], ["error", "failed"]]);

/**
 * One line for a decision's results: "2 landed, 1 sent back (fork changed since it was
 * reviewed)", with each distinct reason or error once.
 * @param {Result[]} results
 * @returns {string}
 */
export function outcome(results) {
	const parts = [];
	for (const [kind, label] of OUTCOMES) {
		const hit = results.filter((r) => r.outcome === kind);
		if (!hit.length) continue;
		const why = [...new Set(hit.map((r) => r.reason || r.error).filter(Boolean))];
		parts.push(hit.length + " " + label + (why.length ? " (" + why.join("; ") + ")" : ""));
	}
	return parts.join(", ") || "nothing was decided";
}
