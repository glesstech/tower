// @ts-check
// The review inbox at /repos/:repo/inbox: changes scored too risky to land on their own, one card
// per group (riskiest first), each decided with one keystroke or click: approve (land what was
// scored), reject (release the plan, with a note) or send back (the agent keeps its fork, with a
// note). Each plan links to its page for the diff and evidence. Reads GET /inbox, decides through
// POST /inbox/decide (operator key only), and refetches when the live feed says the inbox moved.

import { $, ApiError, REPO, ago, api, color, el, failure, live, nav, withKey } from "./client.js";
import { firstLine } from "./model.js";
import { REFETCH, cards, keyAction, outcome, refocus, step } from "./inbox-model.js";

/** @typedef {import("./inbox-model.js").Card} Card */
/** @typedef {import("./inbox-model.js").View} View */
/** @typedef {import("./inbox-model.js").Action} Action */
/** @typedef {import("./inbox-model.js").Decision} Decision */

/** @type {Card[]} */
let list = [];
/** @type {View} */
let view = { mode: "browse", focus: null };
let loaded = false;
// A refetch asked for while a note is being written or a decision sent; it runs once that ends,
// so the cards are never rebuilt under the note input.
let stale = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let debounce;
/** @type {string | null} the card last scrolled into view, so a re-render doesn't fight the user's scrolling */
let shown = null;

const VERB = { approve: "approving", reject: "rejecting", send_back: "sending back" };

nav();

/** The page of one plan, which has its diff and evidence. */
function planHref(/** @type {string} */ id) {
	return withKey("/repos/" + encodeURIComponent(REPO) + "/plans/" + encodeURIComponent(id));
}

async function load() {
	stale = false;
	try {
		const data = await api("/inbox");
		const next = cards(data.decisions);
		view = refocus(view, list, next);
		list = next;
		loaded = true;
		counter(data.headline);
		render();
	} catch (err) {
		$("cards").replaceChildren(failure(err));
	}
}

function refetch() {
	clearTimeout(debounce);
	debounce = setTimeout(() => {
		if (view.mode === "browse") load();
		else stale = true;
	}, 250);
}

/** @param {{ autoLanded: number, decisions: number, text: string }} h */
function counter(h) {
	const c = $("counter");
	c.replaceChildren(el("b", "", String(h.autoLanded)), " landed on their own, ", el("b", "", String(h.decisions)), " needed a human");
	c.title = h.text;
}

function status(/** @type {string | Node} */ content, cls = "ok") {
	const s = $("status");
	s.className = cls;
	s.replaceChildren(content);
}

function render() {
	const box = $("cards");
	if (!list.length) {
		box.replaceChildren(el("div", "empty", loaded ? "Nothing is waiting for a human." : "loading the inbox…"));
		return;
	}
	box.replaceChildren(...list.map(renderCard));
	if (view.focus !== shown) box.querySelector(".card.focus")?.scrollIntoView({ block: "nearest" });
	shown = view.focus;
	/** @type {HTMLInputElement | null} */ (box.querySelector(".note-row input"))?.focus();
}

function renderCard(/** @type {Card} */ c) {
	const focused = view.focus === c.key;
	const card = el("section", "card" + (focused ? " focus" : "") + (focused && view.mode === "deciding" ? " deciding" : ""));
	card.onclick = (e) => {
		if (/** @type {HTMLElement} */ (e.target).closest("a,button,input")) return;
		dispatch({ type: "focus", key: c.key });
	};

	const head = el("div", "head");
	head.append(el("span", "label", c.label), el("span", "score", "risk " + c.score));
	card.append(head, reasons(c.reasons));

	for (const p of c.plans) {
		const item = el("div", "item");
		const what = el("div", "what");
		const agent = el("b", "", p.agent);
		agent.style.color = color(p.agent);
		const task = el("a", "", firstLine(p.task));
		task.href = planHref(p.id);
		task.title = "plan " + p.id + ": its diff and evidence";
		what.append(agent, " ", task);
		if (p.summary) what.append(el("div", "summary", p.summary));
		const paths = el("div", "paths", p.paths.slice(0, 4).join("  ") + (p.paths.length > 4 ? "  +" + (p.paths.length - 4) : ""));
		paths.title = p.paths.join("\n");
		what.append(paths);
		const when = el("div", "when", ago(p.requestedAt));
		when.title = "review requested " + new Date(p.requestedAt).toLocaleString();
		item.append(what, when);
		// A group of one already shows this plan's score and reasons in its header.
		if (c.plans.length > 1) {
			when.prepend(el("span", "score", String(p.risk.score)), " ");
			item.append(reasons(p.risk.reasons));
		}
		card.append(item);
	}

	card.append(actions(c, focused));
	if (focused && view.mode === "note") card.append(noteRow(view.decision, view.note));
	return card;
}

function reasons(/** @type {string[]} */ list) {
	const ul = el("ul", "reasons");
	for (const r of list) ul.append(el("li", "", r));
	return ul;
}

/** @param {Card} c @param {boolean} focused */
function actions(c, focused) {
	const bar = el("div", "actions");
	const busy = view.mode !== "browse";
	/** @param {string} cls @param {string} label @param {string} key @param {Action} action */
	const button = (cls, label, key, action) => {
		const b = el("button", cls, label + " ");
		b.append(el("kbd", "", key));
		b.disabled = busy;
		b.onclick = () => {
			dispatch({ type: "focus", key: c.key });
			dispatch(action);
		};
		return b;
	};
	bar.append(
		button("approve", c.count > 1 ? "Approve all " + c.count : "Approve", "a", { type: "approve" }),
		button("reject", "Reject", "r", { type: "start", decision: "reject" }),
		button("", "Send back", "s", { type: "start", decision: "send_back" }),
	);
	if (focused && view.mode === "deciding") bar.append(el("span", "busy", VERB[view.decision] + "…"));
	return bar;
}

/** @param {"reject" | "send_back"} decision @param {string} note */
function noteRow(decision, note) {
	const row = el("div", "note-row");
	const input = el("input");
	input.value = note;
	input.placeholder = decision === "reject" ? "Why reject? The agent reads this." : "What should the agent change?";
	input.oninput = () => { view = step(view, { type: "type", note: input.value }, list); };
	const send = el("button", decision === "reject" ? "reject" : "", decision === "reject" ? "Reject" : "Send back");
	send.onclick = () => dispatch({ type: "submit" });
	const cancel = el("button", "", "Cancel");
	cancel.onclick = () => dispatch({ type: "cancel" });
	const hint = el("span", "hint");
	hint.append(el("kbd", "", "Enter"), " to send, ", el("kbd", "", "Esc"), " to cancel");
	const wrap = el("div", "actions");
	wrap.append(send, cancel);
	row.append(input, wrap, hint);
	return row;
}

/** Applies an action; sends the decision when the view enters `deciding`. */
function dispatch(/** @type {Action} */ action) {
	if (action.type === "open") {
		const c = list.find((x) => x.key === view.focus);
		if (c) location.href = planHref(c.plans[0].id);
		return;
	}
	const prev = view;
	view = step(view, action, list);
	if (view === prev) return;
	if (view.mode === "deciding") decide(view.decision, view.focus, prev.mode === "note" ? prev.note : "");
	else if (prev.mode !== "browse" && view.mode === "browse" && stale) load();
	render();
}

/** @param {Decision} decision @param {string} group @param {string} note */
async function decide(decision, group, note) {
	status("");
	try {
		const res = await api("/inbox/decide", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ decision, group, ...(note.trim() ? { note: note.trim() } : {}) }),
		});
		status(outcome(res.results), res.results.some((/** @type {any} */ r) => r.outcome === "error") ? "err" : "ok");
	} catch (err) {
		status(err instanceof ApiError && err.status === 401 ? "Deciding needs the operator key." : failure(err, ""), "err");
	}
	view = step(view, { type: "done" }, list);
	await load();
}

document.addEventListener("keydown", (e) => {
	if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
	const typing = /** @type {HTMLElement} */ (e.target).closest("input,textarea,select");
	if (typing && view.mode !== "note") return;
	const action = keyAction(view, e.key);
	if (!action) return;
	if (e.repeat && action.type !== "move") return;
	e.preventDefault();
	dispatch(action);
});

load();

live(
	(ev) => { if (REFETCH.has(ev.type)) refetch(); },
	(s) => {
		$("conn").className = s;
		$("conn").textContent = s;
	},
);

// "requested 5m ago" ticks; never under a note being written.
setInterval(() => { if (loaded && view.mode === "browse") render(); }, 30000);
