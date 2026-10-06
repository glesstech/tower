// @ts-check
// The plan pages' model, with no DOM: a plan's story from its events (phases and how long each
// lasted, the lifecycle timeline), the plan list, a line diff for the changed files, and a small
// markdown parser for the task. Pure, so test/unit/plan-model.test.ts runs it in Node.

/** @typedef {{ path: string, dir: boolean }} Claim */
/** @typedef {{ claims: Claim[], blockedBy: string[], requestedAt: number }} Amendment */
/** @typedef {{ id: string, agent: string, task: string, status: string, claims: Claim[], blockedBy: string[], amendment?: Amendment | null, review?: Review | null, fork?: string | null, base?: string | null, createdAt: number }} Plan */
/** @typedef {{ score: number, level: string, reasons: string[] }} Risk */
/** @typedef {{ summary?: string, evidence?: unknown, risk: Risk, paths: string[], requestedAt: number }} Review */
/** @typedef {{ status: string, from: number, to: number | null }} Phase */
/** @typedef {{ seq: number, at: number, type: string, kind: "info" | "held" | "drift" | "land" | "end", text: string, paths: string[], ids: string[] }} Step */
/** @typedef {{ plan: Plan | null, phases: Phase[], steps: Step[], sha: string | null, summary: string | null, paths: string[], risk: Risk | null }} Story */
/** @typedef {{ plan: Plan, filedAt: number, since: number, sha: string | null }} Row */

/** Every status a plan can be in, in lifecycle order. */
export const STATUSES = ["holding", "cleared", "landed", "released", "expired"];

/** Statuses a plan never leaves. */
export const CLOSED = ["landed", "released", "expired"];

/** "850ms", "42s", "4m 12s", "3h 5m", "2d 4h". */
export function dur(/** @type {number} */ ms) {
	if (ms < 1000) return Math.max(0, Math.round(ms)) + "ms";
	const s = Math.round(ms / 1000);
	if (s < 60) return s + "s";
	if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
	if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
	return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
}

// ── one plan's story ───────────────────────────────────────────────────────

/**
 * Folds a plan's events (GET /events?plan=, in seq order) into its story: the plan as its
 * latest event left it, each status it was in and when, and the timeline.
 * @param {any[]} events
 * @param {(id: string) => string} [nameOf] agent name for a plan id (blockers, deadlock cycles)
 * @returns {Story}
 */
export function story(events, nameOf = (id) => id) {
	/** @type {Story} */
	const s = { plan: null, phases: [], steps: [], sha: null, summary: null, paths: [], risk: null };
	for (const ev of events) {
		if (ev.plan) {
			s.plan = ev.plan;
			const last = s.phases[s.phases.length - 1];
			if (!last || last.status !== ev.plan.status) {
				if (last) last.to = ev.at;
				s.phases.push({ status: ev.plan.status, from: ev.at, to: null });
			}
		}
		if (ev.type === "landed") {
			s.sha = ev.sha || null;
			s.summary = ev.summary || null;
			s.paths = ev.paths || [];
		}
		if (ev.risk) s.risk = ev.risk;
		const step = describe(ev, nameOf);
		if (step) s.steps.push(step);
	}
	return s;
}

/** How long a phase lasted, or has lasted so far. @param {Phase} p @param {number} now */
export function phaseLength(p, now) { return (p.to ?? now) - p.from; }

/**
 * The timeline line for one event, or null for events that are not part of a plan's story.
 * @param {any} ev @param {(id: string) => string} nameOf
 * @returns {Step | null}
 */
export function describe(ev, nameOf) {
	const names = (/** @type {string[] | undefined} */ ids) => (ids || []).map(nameOf).join(", ");
	/** @param {Step["kind"]} kind @param {string} text @param {string[]} [paths] @param {string[]} [ids] @returns {Step} */
	const step = (kind, text, paths, ids) => ({ seq: ev.seq || 0, at: ev.at || 0, type: ev.type, kind, text, paths: paths || [], ids: ids || [] });
	switch (ev.type) {
		case "filed": return step("info", "filed", (ev.plan?.claims || []).map(/** @param {Claim} c */ (c) => c.path));
		case "holding": return step("held", "holding behind " + (names(ev.blockedBy) || "earlier plans"), [], ev.blockedBy);
		case "cleared": return step("info", "cleared for takeoff");
		case "provisioned": return step("info", "got fork " + (ev.fork || "") + (ev.base ? " at " + String(ev.base).slice(0, 7) : ""));
		case "amended": return step("info", "amendment granted", ev.added);
		case "amendment_held": return step("held", "amendment held behind " + names(ev.blockedBy), ev.paths, ev.blockedBy);
		case "deadlock": return step("drift", "amendment refused: deadlock " + names(ev.cycle).replace(/, /g, " → "), ev.paths, ev.cycle);
		case "drift": return step("drift", ev.blocked ? "land rejected: changes outside claims" : "check found changes outside claims", ev.paths);
		case "landed": return step("land", "landed " + String(ev.sha || "").slice(0, 7) + (ev.summary ? ": " + ev.summary : ""), ev.paths);
		case "review": return step("held", "waiting for human review" + riskText(ev.risk));
		case "sent_back": return step("drift", "sent back by review" + (ev.note ? ": " + ev.note : ""));
		case "released": return step("end", ev.rejected ? "rejected in review" + (ev.note ? ": " + ev.note : "") : "released");
		case "expired": return step("end", "lease expired" + (typeof ev.silentFor === "number" ? " after " + dur(ev.silentFor) + " of silence" : ""));
		default: return ev.plan ? step("info", String(ev.type).replace(/_/g, " ")) : null;
	}
}

/** " (risk 7: no test evidence; 12 files)" for a risk score, or "". @param {Risk | undefined} r */
export function riskText(r) {
	if (!r) return "";
	return " (risk " + r.score + (r.reasons?.length ? ": " + r.reasons.join("; ") : "") + ")";
}

// ── the plan list ──────────────────────────────────────────────────────────

/**
 * Applies one event to the list of every plan by id. Events without a plan only matter for
 * the land's trunk SHA, which a "landed" event carries alongside its plan.
 * @param {Record<string, Row>} rows @param {any} ev
 */
export function listApply(rows, ev) {
	/** @type {Plan | undefined} */
	const p = ev.plan;
	if (!p) return;
	const row = rows[p.id];
	if (!row) rows[p.id] = { plan: p, filedAt: p.createdAt || ev.at, since: ev.at, sha: null };
	else {
		if (row.plan.status !== p.status) row.since = ev.at;
		row.plan = p;
	}
	if (ev.type === "landed") rows[p.id].sha = ev.sha || null;
}

/** Rows newest first, only those with `status` if given. @param {Record<string, Row>} rows @param {string} [status] */
export function listRows(rows, status) {
	return Object.values(rows)
		.filter((r) => !status || r.plan.status === status)
		.sort((a, b) => b.filedAt - a.filedAt);
}

/** How many plans are in each status. @param {Record<string, Row>} rows */
export function counts(rows) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const r of Object.values(rows)) out[r.plan.status] = (out[r.plan.status] || 0) + 1;
	return out;
}

// ── line diff ──────────────────────────────────────────────────────────────

/** @typedef {{ op: " " | "-" | "+", text: string, a: number | null, b: number | null }} Line */
/** @typedef {Line | { op: "skip", count: number }} Folded */

/** Above this many cells in the LCS table, the changed middle is shown as removed then added. */
export const DIFF_CELLS = 4_000_000;

/** A file's text as lines, without the empty string after a trailing newline. */
export function lines(/** @type {string | null | undefined} */ text) {
	if (!text) return [];
	const out = text.split("\n");
	if (out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * A line diff of two texts (null for a side that doesn't exist): common prefix and suffix,
 * then an LCS over what's left. Line numbers are 1-based.
 * @param {string | null} before @param {string | null} after
 * @returns {Line[]}
 */
export function lineDiff(before, after) {
	const a = lines(before);
	const b = lines(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

	/** @type {Line[]} */
	const out = [];
	for (let i = 0; i < start; i++) out.push({ op: " ", text: a[i], a: i + 1, b: i + 1 });
	const n = endA - start;
	const m = endB - start;
	if (n * m > DIFF_CELLS) {
		for (let i = start; i < endA; i++) out.push({ op: "-", text: a[i], a: i + 1, b: null });
		for (let j = start; j < endB; j++) out.push({ op: "+", text: b[j], a: null, b: j + 1 });
	} else {
		// lcs[i][j]: the LCS length of a[start+i..endA) and b[start+j..endB).
		const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && a[start + i] === b[start + j]) {
				out.push({ op: " ", text: a[start + i], a: start + i + 1, b: start + j + 1 });
				i++; j++;
			} else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
				// Removals before additions, as unified diffs show them.
				out.push({ op: "-", text: a[start + i], a: start + i + 1, b: null });
				i++;
			} else {
				out.push({ op: "+", text: b[start + j], a: null, b: start + j + 1 });
				j++;
			}
		}
	}
	for (let i = endA, j = endB; i < a.length; i++, j++) out.push({ op: " ", text: a[i], a: i + 1, b: j + 1 });
	return out;
}

/**
 * The diff with unchanged runs longer than 2 * context folded into a skip marker, keeping
 * `context` lines of them next to each change.
 * @param {Line[]} diff @param {number} [context]
 * @returns {Folded[]}
 */
export function fold(diff, context = 3) {
	/** @type {Folded[]} */
	const out = [];
	let i = 0;
	while (i < diff.length) {
		if (diff[i].op !== " ") { out.push(diff[i++]); continue; }
		let j = i;
		while (j < diff.length && diff[j].op === " ") j++;
		const keepHead = i === 0 ? 0 : context;
		const keepTail = j === diff.length ? 0 : context;
		if (j - i > keepHead + keepTail + 1) {
			out.push(...diff.slice(i, i + keepHead), { op: "skip", count: j - i - keepHead - keepTail }, ...diff.slice(j - keepTail, j));
		} else {
			out.push(...diff.slice(i, j));
		}
		i = j;
	}
	return out;
}

/** Lines added and removed. @param {Line[]} diff */
export function stat(diff) {
	let added = 0;
	let removed = 0;
	for (const l of diff) {
		if (l.op === "+") added++;
		else if (l.op === "-") removed++;
	}
	return { added, removed };
}

// ── markdown ───────────────────────────────────────────────────────────────

/** @typedef {{ type: "text" | "code" | "strong" | "em", text: string } | { type: "link", text: string, href: string }} Inline */
/**
 * @typedef {{ type: "h", level: number, inline: Inline[] }
 *   | { type: "p" | "quote", inline: Inline[] }
 *   | { type: "ul" | "ol", items: Inline[][] }
 *   | { type: "code", text: string }} Block
 */

/**
 * Enough markdown for a task: headings, paragraphs, lists, quotes, fenced code, and inline
 * code, bold, italics and links. Parsed to plain data; the page builds DOM nodes from it with
 * textContent, so nothing an agent writes is ever parsed as HTML. Only http(s) links survive.
 * @param {string} text
 * @returns {Block[]}
 */
export function markdown(text) {
	/** @type {Block[]} */
	const out = [];
	const src = (text || "").replace(/\r\n?/g, "\n").split("\n");
	/** @type {string[]} */
	let para = [];
	const flush = () => {
		if (para.length) out.push({ type: "p", inline: inline(para.join(" ")) });
		para = [];
	};
	for (let i = 0; i < src.length; i++) {
		const line = src[i];
		const fence = line.match(/^\s*(```|~~~)/);
		if (fence) {
			flush();
			const body = [];
			for (i++; i < src.length && !src[i].trimStart().startsWith(fence[1]); i++) body.push(src[i]);
			out.push({ type: "code", text: body.join("\n") });
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (h) { flush(); out.push({ type: "h", level: h[1].length, inline: inline(h[2]) }); continue; }
		const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
		if (item) {
			flush();
			const type = /\d/.test(item[1]) ? "ol" : "ul";
			const last = out[out.length - 1];
			if (last && last.type === type) last.items.push(inline(item[2]));
			else out.push({ type, items: [inline(item[2])] });
			continue;
		}
		const quote = line.match(/^\s*>\s?(.*)$/);
		if (quote) { flush(); out.push({ type: "quote", inline: inline(quote[1]) }); continue; }
		if (!line.trim()) { flush(); continue; }
		// A continuation line of a list item joins it rather than starting a paragraph.
		const last = out[out.length - 1];
		if (!para.length && /^\s+\S/.test(line) && last && (last.type === "ul" || last.type === "ol")) {
			last.items[last.items.length - 1].push({ type: "text", text: " " }, ...inline(line.trim()));
			continue;
		}
		para.push(line.trim());
	}
	flush();
	return out;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|\b_([^_\s][^_]*)_\b|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** @returns {Inline[]} */
export function inline(/** @type {string} */ text) {
	/** @type {Inline[]} */
	const out = [];
	let at = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > at) out.push({ type: "text", text: text.slice(at, m.index) });
		if (m[1] != null) out.push({ type: "code", text: m[1] });
		else if (m[2] != null || m[3] != null) out.push({ type: "strong", text: m[2] ?? m[3] });
		else if (m[4] != null) out.push(/^https?:\/\//i.test(m[5]) ? { type: "link", text: m[4], href: m[5] } : { type: "text", text: m[4] });
		else if (m[6] != null || m[7] != null) out.push({ type: "em", text: m[6] ?? m[7] });
		else out.push({ type: "link", text: m[8], href: m[8] });
		at = m.index + m[0].length;
	}
	if (at < text.length) out.push({ type: "text", text: text.slice(at) });
	return out;
}
