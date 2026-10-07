// @ts-check
// One plan's page at /repos/:repo/plans/:id: the pull request, rethought. The header has the
// agent, status and how long the plan spent in each state; then the task (markdown), its
// airspace (claims and any amendment, granted or held and on whom), and the lifecycle from the
// event log. While in flight it shows the fork and the paths touched so far (with drift); once
// landed, the trunk SHA, every changed file with a diff, and the evidence. Every path links to
// the code explorer's history for it. Shareable with the read-only dashboard key.

import { $, REPO, ago, api, color, el, live, nav, withKey } from "./client.js";
import { CLOSED, dur, fold, lineDiff, markdown, phaseLength, riskText, stat, story } from "./plan-model.js";

/** @typedef {import("./plan-model.js").Plan} Plan */
/** @typedef {import("./plan-model.js").Story} Story */
/** @typedef {import("./plan-model.js").Block} Block */
/** @typedef {import("./plan-model.js").Inline} Inline */
/** @typedef {{ hash: string, mode: string, size: number, binary: boolean, text: string | null }} Side */
/** @typedef {{ path: string, op: "added" | "modified" | "deleted", old: Side | null, new: Side | null, outside?: boolean }} FileDiff */
/** @typedef {{ plan: Plan, source: "trunk" | "fork" | null, sha: string | null, fork: string | null, base: string | null, head: string | null, files: FileDiff[], truncated: boolean, note?: string }} PlanDiff */

const ID = decodeURIComponent((location.pathname.match(/\/plans\/([^/]+)/) || ["", ""])[1]);

/** @type {any[]} this plan's events, in seq order */
let events = [];
/** @type {Story} */
let s = story([]);
/** @type {Record<string, string>} agent names of other plans (blockers, deadlock cycles) */
const names = {};
/** @type {PlanDiff | null} */
let diff = null;
/** @type {any} the land row from /why, with its evidence */
let land = null;

nav();
document.title = "tower · plan " + ID;

const nameOf = (/** @type {string} */ id) => names[id] || id;

/** A link to a path in the code explorer, where its history ("why") is. */
function pathLink(/** @type {string} */ path, /** @type {string} */ cls = "path") {
	const a = el("a", cls, path);
	a.href = withKey("/repos/" + encodeURIComponent(REPO) + "/code?path=" + encodeURIComponent(path));
	a.title = "why " + path + " looks the way it does";
	return a;
}

function planLink(/** @type {string} */ id) {
	const a = el("a", "", nameOf(id));
	a.href = withKey("/repos/" + encodeURIComponent(REPO) + "/plans/" + encodeURIComponent(id));
	if (names[id]) a.style.color = color(names[id]);
	a.title = "plan " + id;
	return a;
}

function agentEl(/** @type {string} */ agent) {
	const b = el("b", "agent", agent);
	b.style.color = color(agent);
	return b;
}

function none(/** @type {string} */ text) { return el("div", "none", text); }

function box(/** @type {string} */ id) { return /** @type {HTMLElement} */ ($(id).querySelector("div")); }

// ── header and task ────────────────────────────────────────────────────────

function renderHead() {
	const head = $("head");
	head.replaceChildren();
	const p = s.plan;
	if (!p) return void head.appendChild(none(events.length ? "this plan has no lifecycle events" : "no such plan (or its events were pruned)"));
	const now = Date.now();
	const title = el("div", "title");
	title.append(el("span", "pill " + p.status, p.status));
	if (p.review) title.appendChild(el("span", "pill review", "in human review " + dur(now - p.review.requestedAt)));
	title.append(agentEl(p.agent), el("code", "id", "plan " + p.id));
	const filed = el("span", "dim", "filed " + ago(p.createdAt, now));
	filed.title = new Date(p.createdAt).toLocaleString();
	title.appendChild(filed);
	head.appendChild(title);

	// How long it spent in each state, as a bar and as text.
	const total = s.phases.reduce((n, ph) => n + phaseLength(ph, now), 0) || 1;
	const bar = el("div", "phases");
	const legend = el("div", "legend");
	for (const ph of s.phases) {
		const len = phaseLength(ph, now);
		const seg = el("i", "seg " + ph.status);
		seg.style.flexGrow = String(Math.max(len / total, 0.02));
		seg.title = ph.status + " " + dur(len) + (ph.to == null && !CLOSED.includes(ph.status) ? " so far" : "");
		bar.appendChild(seg);
		if (CLOSED.includes(ph.status)) legend.appendChild(el("span", "", ph.status + " " + ago(ph.from, now)));
		else legend.appendChild(el("span", "", ph.status + " " + dur(len) + (ph.to == null ? " (now)" : "")));
	}
	head.append(bar, legend);

	const refs = el("div", "refs");
	if (s.sha) refs.append("trunk ", el("code", "sha", s.sha), s.summary ? el("span", "", " " + s.summary) : "");
	else if (p.fork) refs.append("fork ", el("code", "", p.fork), p.base ? el("span", "dim", " from " + p.base.slice(0, 7)) : "");
	if (refs.childNodes.length) head.appendChild(refs);
}

function renderTask() {
	const box = $("task");
	box.replaceChildren(...(s.plan ? markdown(s.plan.task).map(block) : []));
}

/** @param {Block} b @returns {HTMLElement} */
function block(b) {
	if (b.type === "code") return el("pre", "", b.text);
	if ("items" in b) {
		const list = el(b.type);
		for (const item of b.items) list.appendChild(inlines(el("li"), item));
		return list;
	}
	if (b.type === "h") return inlines(el(/** @type {"h3"} */ ("h" + Math.min(b.level + 1, 6))), b.inline);
	return inlines(el(b.type === "quote" ? "blockquote" : "p"), b.inline);
}

/** @param {HTMLElement} into @param {Inline[]} parts */
function inlines(into, parts) {
	for (const part of parts) {
		if (part.type === "text") into.append(part.text);
		else if (part.type === "link") {
			const a = el("a", "", part.text);
			a.href = part.href;
			a.rel = "noopener noreferrer";
			a.target = "_blank";
			into.appendChild(a);
		} else into.appendChild(el(part.type, "", part.text));
	}
	return into;
}

// ── airspace and lifecycle ─────────────────────────────────────────────────

function renderAirspace() {
	const out = box("airspace");
	out.replaceChildren();
	const p = s.plan;
	if (!p) return;
	const ul = el("ul", "claims");
	for (const c of p.claims) {
		const li = el("li");
		li.appendChild(pathLink(c.path));
		if (c.dir) li.appendChild(el("span", "dim", " (directory)"));
		ul.appendChild(li);
	}
	out.appendChild(ul);

	const granted = s.steps.filter((x) => x.type === "amended");
	for (const g of granted) {
		const div = el("div", "amend granted");
		div.append("amendment granted " + ago(g.at) + ": ");
		g.paths.forEach((x, i) => div.append(i ? ", " : "", pathLink(x)));
		out.appendChild(div);
	}
	if (p.amendment) {
		const div = el("div", "amend held");
		div.append("amendment held ", el("span", "dim", "(" + dur(Date.now() - p.amendment.requestedAt) + ")"), ": ");
		p.amendment.claims.forEach((c, i) => div.append(i ? ", " : "", pathLink(c.path)));
		div.append(" — waiting on ");
		p.amendment.blockedBy.forEach((id, i) => div.append(i ? ", " : "", planLink(id)));
		out.appendChild(div);
	}
	// A held amendment is cleared from the plan when it closes; the log still has it.
	const lastHeld = s.steps.findLastIndex((x) => x.type === "amendment_held");
	if (!p.amendment && lastHeld >= 0 && !s.steps.slice(lastHeld).some((x) => x.type === "amended")) {
		const held = s.steps[lastHeld];
		const div = el("div", "amend held");
		div.append("amendment held " + ago(held.at) + (CLOSED.includes(p.status) ? ", never granted" : "") + ": ");
		held.paths.forEach((x, i) => div.append(i ? ", " : "", pathLink(x)));
		div.append(" — waited on ");
		held.ids.forEach((id, i) => div.append(i ? ", " : "", planLink(id)));
		out.appendChild(div);
	}
	if (p.status === "holding" && p.blockedBy.length) {
		const div = el("div", "amend held");
		div.append("holding behind ");
		p.blockedBy.forEach((id, i) => div.append(i ? ", " : "", planLink(id)));
		out.appendChild(div);
	}
}

/** @type {Record<string, string>} what precedes the plan names in a step that names other plans */
const LEADS = { holding: "holding behind ", amendment_held: "amendment held behind ", deadlock: "amendment refused: deadlock " };

function renderTimeline() {
	const out = box("timeline");
	out.replaceChildren();
	if (!s.steps.length) return void out.appendChild(none("no events"));
	const ol = el("ol", "steps");
	const start = s.steps[0].at;
	for (const step of s.steps) {
		const li = el("li", step.kind);
		const when = el("span", "when", "+" + dur(step.at - start));
		when.title = new Date(step.at).toLocaleString();
		const text = el("span", "text");
		// Blocker names become links to their plans.
		const lead = LEADS[step.type];
		if (lead && step.ids.length) {
			text.append(lead);
			const sep = step.type === "deadlock" ? " → " : ", ";
			step.ids.forEach((id, i) => text.append(i ? sep : "", planLink(id)));
		} else text.append(step.text);
		li.append(when, text);
		if (step.paths.length) {
			const paths = el("div", "paths");
			step.paths.forEach((x) => paths.append(pathLink(x), " "));
			li.appendChild(paths);
		}
		ol.appendChild(li);
	}
	out.appendChild(ol);
}

// ── changes and evidence ───────────────────────────────────────────────────

function renderChanges() {
	const out = box("changes");
	out.replaceChildren();
	const p = s.plan;
	if (!p) return;
	if (!diff) return void out.appendChild(none(p.status === "holding" ? "holding: no fork yet" : "loading…"));
	if (diff.source === "fork") {
		const live = el("div", "note");
		live.append("in flight in ", el("code", "", diff.fork || ""), " at ", el("code", "", (diff.head || "").slice(0, 7)), ": touched so far (refreshes as it changes)");
		out.appendChild(live);
	} else if (diff.source === "trunk") {
		const n = el("div", "note");
		n.append("landed on trunk as ", el("code", "", diff.sha || ""));
		out.appendChild(n);
	}
	if (diff.note) out.appendChild(none(diff.note));
	if (!diff.files.length) {
		if (diff.source) out.appendChild(none("no changes yet"));
		return;
	}
	const drift = diff.files.filter((f) => f.outside);
	if (drift.length) out.appendChild(el("div", "warn", drift.length + " path(s) outside the claims: landing will be refused until they are undone or claimed"));
	for (const f of diff.files) out.appendChild(fileEl(f));
	if (diff.truncated) out.appendChild(none("contents are shown for the first files only"));
}

/** @param {FileDiff} f */
function fileEl(f) {
	const det = el("details", "file" + (f.outside ? " outside" : ""));
	const sum = el("summary");
	const text = (/** @type {Side | null} */ x) => (x && x.text != null ? x.text : null);
	const lines = f.old?.binary || f.new?.binary ? null : lineDiff(text(f.old), text(f.new));
	const st = lines ? stat(lines) : null;
	sum.append(el("span", "op " + f.op, f.op[0].toUpperCase()), pathLink(f.path));
	if (st) sum.append(el("span", "add", " +" + st.added), el("span", "del", " −" + st.removed));
	if (f.outside) sum.appendChild(el("span", "warn", " outside claims"));
	det.appendChild(sum);
	det.ontoggle = () => {
		if (!det.open || det.childElementCount > 1) return;
		if (f.old?.binary || f.new?.binary) return void det.appendChild(none("binary file"));
		if ((f.old && f.old.text == null) || (f.new && f.new.text == null)) return void det.appendChild(none("file too large to show"));
		det.appendChild(diffTable(lines || []));
	};
	// Small diffs start open, so a landed plan reads like a PR at a glance.
	if (st && st.added + st.removed <= 80 && diff && diff.files.length <= 12) det.open = true;
	return det;
}

/** @param {import("./plan-model.js").Line[]} lines */
function diffTable(lines) {
	const table = el("table", "diff");
	for (const row of fold(lines)) {
		const tr = el("tr", row.op === "+" ? "add" : row.op === "-" ? "del" : row.op === "skip" ? "skip" : "");
		if (row.op === "skip") {
			const td = el("td", "", "⋯ " + row.count + " unchanged line" + (row.count === 1 ? "" : "s"));
			td.colSpan = 4;
			tr.appendChild(td);
		} else {
			tr.append(el("td", "n", row.a == null ? "" : String(row.a)), el("td", "n", row.b == null ? "" : String(row.b)), el("td", "o", row.op), el("td", "", row.text));
		}
		table.appendChild(tr);
	}
	return table;
}

function renderEvidence() {
	const out = box("evidence");
	out.replaceChildren();
	const p = s.plan;
	if (!p) return;
	// A land waiting in the human inbox carries its evidence on the plan until it is decided.
	if (p.review) {
		out.appendChild(el("div", "note", "waiting for human review" + riskText(p.review.risk)));
		return evidenceEl(out, p.review.summary || "", p.review.evidence);
	}
	if (p.status !== "landed") return void out.appendChild(none(CLOSED.includes(p.status) ? "nothing landed, so no evidence" : "filed with the land"));
	if (!land) return void out.appendChild(none("loading…"));
	if (s.risk) out.appendChild(el("div", "note", "risk " + s.risk.score + " (" + s.risk.level + ")" + (s.risk.reasons.length ? ": " + s.risk.reasons.join("; ") : "")));
	evidenceEl(out, land.summary, land.evidence);
}

/** The summary, then each evidence field (request, plan, checks first) expandable. @param {HTMLElement} out @param {string} summary @param {any} e */
function evidenceEl(out, summary, e) {
	if (summary) out.appendChild(el("div", "sum", summary));
	if (e == null || e === "") return void out.appendChild(none("no evidence given"));
	if (typeof e !== "object") return void out.appendChild(el("pre", "", String(e)));
	const keys = Object.keys(e).sort((a, b) => order(a) - order(b));
	for (const k of keys) {
		const det = el("details", "ev");
		det.open = true;
		det.appendChild(el("summary", "", k));
		const v = e[k];
		det.appendChild(el("pre", "", typeof v === "string" ? v : JSON.stringify(v, null, 2)));
		out.appendChild(det);
	}
}

function order(/** @type {string} */ k) {
	const i = ["request", "plan", "checks"].indexOf(k);
	return i < 0 ? 3 : i;
}

function render() {
	renderHead();
	renderTask();
	renderAirspace();
	renderTimeline();
	renderChanges();
	renderEvidence();
}

// ── loading ────────────────────────────────────────────────────────────────

async function loadEvents() {
	/** @type {any[]} */
	const all = [];
	let since = 0;
	for (;;) {
		const page = await api("/events?plan=" + encodeURIComponent(ID) + "&since=" + since + "&limit=10000");
		all.push(...page.events);
		if (page.events.length < 10000) break;
		since = page.last;
	}
	return all;
}

/** Agent names for every plan id the story mentions, from each plan's first event. */
async function loadNames() {
	const ids = new Set(events.flatMap((ev) => [...(ev.blockedBy || []), ...(ev.cycle || []), ...(ev.plan?.amendment?.blockedBy || [])]));
	await Promise.all(
		[...ids].filter((id) => id !== ID && !names[id]).map((id) =>
			api("/events?plan=" + encodeURIComponent(id) + "&limit=1").then(
				(r) => { if (r.events[0]?.agent) names[id] = r.events[0].agent; },
				() => {},
			),
		),
	);
	if (s.plan) names[ID] = s.plan.agent;
}

function update() {
	s = story(events, nameOf);
	if (s.plan) names[ID] = s.plan.agent;
	render();
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let diffTimer;
let diffBusy = false;

// Each diff costs Artifacts reads, so it is fetched on load, after this plan's events (debounced),
// and on a slow timer while in flight; never for a plan that has no fork.
function loadDiffSoon(delay = 1500) {
	clearTimeout(diffTimer);
	diffTimer = setTimeout(loadDiff, delay);
}

async function loadDiff() {
	const p = s.plan;
	if (!p || p.status === "holding" || diff?.source === "trunk") return;
	if (diffBusy) return loadDiffSoon();
	diffBusy = true;
	try {
		diff = await api("/plans/" + encodeURIComponent(ID) + "/diff");
	} catch {
		diff = { plan: p, source: null, sha: null, fork: null, base: null, head: null, files: [], truncated: false, note: "could not load the diff" };
	}
	diffBusy = false;
	renderChanges();
	const now = s.plan?.status;
	if (now === "cleared") loadDiffSoon(30000);
	else if (now === "landed" && diff?.source !== "trunk") loadDiffSoon(); // landed while this was loading
	if (now === "landed") loadEvidence();
}

async function loadEvidence() {
	const path = s.paths[0] || diff?.files[0]?.path;
	if (!path || land) return;
	try {
		const lands = await api("/why?limit=1000&path=" + encodeURIComponent(path));
		land = lands.find((/** @type {any} */ l) => l.plan_id === ID) || { summary: s.summary || "", evidence: null };
	} catch {
		land = { summary: s.summary || "", evidence: "could not load the evidence" };
	}
	renderEvidence();
}

loadEvents().then(
	async (list) => {
		// Keep anything the live feed delivered while this loaded.
		const seen = new Set(list.map((e) => e.seq));
		events = [...list, ...events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
		update();
		await loadNames();
		update();
		loadDiff();
	},
	() => {
		$("head").replaceChildren(none("could not load this plan (is ?key= set?)"));
	},
);

live((ev) => {
	if (ev.type === "reset") {
		events = [];
		diff = null;
		land = null;
		return update();
	}
	if ((ev.planId || ev.plan?.id) !== ID || typeof ev.seq !== "number") return;
	if (events.some((e) => e.seq === ev.seq)) return;
	events.push(ev);
	events.sort((a, b) => a.seq - b.seq);
	update();
	loadNames().then(update);
	if (ev.type === "landed") diff = null;
	loadDiffSoon();
});

// Durations tick while the plan is open.
setInterval(() => {
	if (s.plan && !CLOSED.includes(s.plan.status)) {
		renderHead();
		renderAirspace();
	}
}, 5000);
