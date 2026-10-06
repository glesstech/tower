// @ts-check
// The plan list at /repos/:repo/plans: every plan in the event log, newest first, filtered by
// status (?status=), each linking to its page at /repos/:repo/plans/:id. Built from /events
// (the snapshot in /state only has active plans), then kept current by the live feed.

import { $, REPO, ago, api, color, el, live, nav, withKey } from "./client.js";
import { firstLine } from "./model.js";
import { CLOSED, STATUSES, counts, dur, listApply, listRows } from "./plan-model.js";

/** @typedef {import("./plan-model.js").Row} Row */

/** @type {Record<string, Row>} */
let rows = {};
let status = new URLSearchParams(location.search).get("status") || "";
let loaded = false;

nav();

/** The page of one plan. */
function planHref(/** @type {string} */ id) {
	return withKey("/repos/" + encodeURIComponent(REPO) + "/plans/" + encodeURIComponent(id));
}

function setStatus(/** @type {string} */ s) {
	status = s;
	const q = new URLSearchParams(location.search);
	if (s) q.set("status", s);
	else q.delete("status");
	history.replaceState(null, "", location.pathname + "?" + q.toString());
	render();
}

function render() {
	const n = counts(rows);
	const bar = $("filters");
	bar.replaceChildren();
	for (const s of ["", ...STATUSES, ...Object.keys(n).filter((k) => !STATUSES.includes(k))]) {
		const total = s ? n[s] || 0 : Object.keys(rows).length;
		const b = el("button", "chip " + (s || "all") + (s === status ? " on" : ""), (s || "all") + " " + total);
		b.onclick = () => setStatus(s);
		bar.appendChild(b);
	}

	const list = listRows(rows, status);
	if (!list.length) return message(!loaded ? "loading plans…" : status ? "no " + status + " plans" : "no plans filed yet");
	const body = /** @type {HTMLElement} */ ($("list").querySelector("tbody"));
	body.replaceChildren();
	const now = Date.now();
	for (const r of list) {
		const p = r.plan;
		const tr = el("tr");
		tr.onclick = (e) => {
			if (/** @type {HTMLElement} */ (e.target).closest("a")) return;
			location.href = planHref(p.id);
		};
		const agent = el("b", "", p.agent);
		agent.style.color = color(p.agent);
		const task = el("a", "", firstLine(p.task));
		task.href = planHref(p.id);
		const paths = p.claims.map((c) => c.path);
		const claims = cell("claims", paths.slice(0, 3).join(" ") + (paths.length > 3 ? " +" + (paths.length - 3) : ""));
		claims.title = paths.join("\n");
		const filed = cell("dim", ago(r.filedAt, now));
		filed.title = new Date(r.filedAt).toLocaleString();
		tr.append(
			cell("", el("span", "pill " + (p.review ? "review" : p.status), p.review ? "in review" : p.status)),
			cell("", agent),
			cell("task", task),
			claims,
			filed,
			cell("dim", CLOSED.includes(p.status) ? "" : dur(now - r.since)),
			cell("mono", r.sha ? r.sha.slice(0, 7) : ""),
		);
		body.appendChild(tr);
	}
}

/** A table cell holding text or a node. @param {string} cls @param {string | Node} content */
function cell(cls, content) {
	const td = el("td", cls);
	td.append(content);
	return td;
}

/** The whole table body as one message. */
function message(/** @type {string} */ text) {
	const td = cell("none", text);
	td.colSpan = 7;
	const tr = el("tr");
	tr.appendChild(td);
	/** @type {HTMLElement} */ ($("list").querySelector("tbody")).replaceChildren(tr);
}

async function load() {
	/** @type {Record<string, Row>} */
	const next = {};
	let since = 0;
	for (;;) {
		const page = await api("/events?since=" + since + "&limit=10000");
		for (const ev of page.events) listApply(next, ev);
		if (page.events.length < 10000) break;
		since = page.last;
	}
	return next;
}

load().then(
	(r) => {
		// The live feed may have applied newer events while this loaded; they win.
		for (const id in rows) r[id] = rows[id];
		rows = r;
		loaded = true;
		render();
	},
	() => message("could not load plans (is ?key= set?)"),
);

// The live feed's first message is a snapshot of active plans; closed ones stay as loaded.
live(
	(ev) => {
		if (ev.type === "reset") rows = {};
		else if (ev.type === "state") for (const p of ev.state.plans) listApply(rows, { type: p.status, at: Date.now(), plan: p });
		else listApply(rows, ev);
		if (loaded) render();
	},
	(s) => {
		$("conn").className = s;
		$("conn").textContent = s;
	},
);

// "in this state" ticks for plans in flight.
setInterval(() => { if (loaded) render(); }, 15000);
