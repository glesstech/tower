// @ts-check
// The code explorer at /repos/:repo/code: trunk HEAD's file tree with a badge on every path an
// in-flight (solid) or holding (dashed) plan claims, the open file's contents, and beside it
// why it looks that way: every land that touched it (task, agent, summary, evidence, plan).
// A directory shows its files, the lands under it, and who is in that airspace right now.
// The open path lives in ?path= ("src/a.ts" for a file, "src/" for a directory, "" for root).

import { $, REPO, ago, api, color, el, live, nav, withKey } from "./client.js";

/** @typedef {{ path: string, dir: boolean }} Claim */
/** @typedef {{ id: string, agent: string, task: string, status: string, claims: Claim[], blockedBy: string[] }} Plan */
/** @typedef {{ sha: string, plan_id: string, agent: string, task: string, summary: string, evidence: any, landed_at: number, paths?: string[] }} Land */
/** @typedef {{ name: string, path: string, dirs: Record<string, Dir>, files: string[] }} Dir */

/** @type {Record<string, Plan>} active (holding or cleared) plans by id */
let plans = {};
/** @type {Land[]} the newest lands from the state snapshot, for the root directory */
let recent = [];
/** @type {Dir} */
let root = { name: "", path: "", dirs: {}, files: [] };
let head = "";
/** @type {Set<string>} directories the tree has open */
const opened = new Set([""]);
let current = new URLSearchParams(location.search).get("path") || "";
/** Bumped on every navigation so a slow response for an old path is dropped. */
let seq = 0;

nav();

// ── airspace ───────────────────────────────────────────────────────────────

/** Does a claim reach this node? A directory is reached by any claim inside it or above it. */
function reaches(/** @type {Claim} */ c, /** @type {string} */ path) {
	if (path === "") return true;
	if (path.endsWith("/")) return c.path.startsWith(path) || (c.dir && path.startsWith(c.path));
	return c.dir ? path.startsWith(c.path) : c.path === path;
}

/** Active plans with a claim on this node, cleared first. */
function occupants(/** @type {string} */ path) {
	return Object.values(plans)
		.filter((p) => p.claims.some((c) => reaches(c, path)))
		.sort((a, b) => (a.status === b.status ? 0 : a.status === "cleared" ? -1 : 1));
}

function badges(/** @type {string} */ path) {
	const span = el("span");
	for (const p of occupants(path)) {
		const b = el("i", "badge " + p.status);
		b.style.color = color(p.agent);
		b.title = p.agent + " (" + p.status + "): " + p.task;
		span.appendChild(b);
	}
	return span;
}

// ── tree ───────────────────────────────────────────────────────────────────

function loadTree() {
	return api("/tree").then((t) => {
		head = t.head || "";
		root = { name: "", path: "", dirs: {}, files: [] };
		for (const path of /** @type {string[]} */ (t.paths)) {
			const parts = path.split("/");
			let d = root;
			for (const name of parts.slice(0, -1)) d = d.dirs[name] ??= { name, path: d.path + name + "/", dirs: {}, files: [] };
			d.files.push(path);
		}
		$("head").textContent = head.slice(0, 7) + (t.truncated ? " (truncated)" : "");
		renderTree();
	});
}

/** A link that opens `path` in the explorer. */
function link(/** @type {string} */ path, /** @type {string} */ label) {
	const a = el("a", path === current ? "open" : "");
	a.href = withKey("/repos/" + encodeURIComponent(REPO) + "/code?path=" + encodeURIComponent(path));
	a.append(el("span", "", label), badges(path));
	a.onclick = (e) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		go(path);
	};
	return a;
}

function renderTree() {
	const box = $("tree");
	box.replaceChildren();
	if (!head) return void box.appendChild(el("div", "none", "trunk is empty"));
	box.appendChild(link("", REPO || "/"));
	renderDir(root, box);
}

function renderDir(/** @type {Dir} */ d, /** @type {HTMLElement} */ into) {
	for (const sub of Object.values(d.dirs).sort((a, b) => a.name.localeCompare(b.name))) {
		const det = el("details");
		det.open = opened.has(sub.path);
		det.ontoggle = () => {
			if (det.open) opened.add(sub.path);
			else opened.delete(sub.path);
		};
		const sum = el("summary");
		sum.appendChild(link(sub.path, sub.name + "/"));
		det.appendChild(sum);
		renderDir(sub, det);
		into.appendChild(det);
	}
	for (const f of d.files) into.appendChild(link(f, f.slice(d.path.length)));
}

/** The directory node for "src/x/", or null if trunk has none. */
function dirAt(/** @type {string} */ path) {
	let d = root;
	for (const name of path.split("/").filter(Boolean)) {
		const next = d.dirs[name];
		if (!next) return null;
		d = next;
	}
	return d;
}

// ── navigation ─────────────────────────────────────────────────────────────

function go(/** @type {string} */ path) {
	current = path;
	const q = new URLSearchParams(location.search);
	if (path) q.set("path", path);
	else q.delete("path");
	history.pushState(null, "", location.pathname + "?" + q.toString());
	show();
}

window.onpopstate = () => {
	current = new URLSearchParams(location.search).get("path") || "";
	show();
};

function show() {
	// Open every directory above the current path so it is visible in the tree.
	const parts = current.split("/");
	for (let i = 1; i < parts.length; i++) opened.add(parts.slice(0, i).join("/") + "/");
	if (current.endsWith("/")) opened.add(current);
	renderTree();
	renderCrumbs();
	renderAirspace();
	const mine = ++seq;
	const dir = current === "" || current.endsWith("/");
	if (dir) showDir();
	else showFile(mine);
	showWhy(mine);
}

function renderCrumbs() {
	const h = $("crumbs");
	h.replaceChildren();
	const parts = current.split("/");
	const crumb = (/** @type {string} */ path, /** @type {string} */ label) => {
		const a = link(path, label);
		a.className = "";
		a.querySelector("span + span")?.remove();
		return a;
	};
	h.appendChild(crumb("", REPO || "/"));
	for (let i = 0; i < parts.length; i++) {
		if (!parts[i]) continue;
		const last = i === parts.length - 1;
		h.append(" / ", last ? el("span", "", parts[i]) : crumb(parts.slice(0, i + 1).join("/") + "/", parts[i]));
	}
}

function showDir() {
	const body = $("body");
	body.replaceChildren();
	const d = dirAt(current);
	$("meta").textContent = "";
	if (!d) return void body.appendChild(el("div", "note", head ? "not a directory on trunk" : "trunk is empty"));
	const ul = el("ul", "listing");
	for (const sub of Object.values(d.dirs).sort((a, b) => a.name.localeCompare(b.name))) {
		const li = el("li");
		li.appendChild(link(sub.path, sub.name + "/"));
		ul.appendChild(li);
	}
	for (const f of d.files) {
		const li = el("li");
		li.appendChild(link(f, f.slice(d.path.length)));
		ul.appendChild(li);
	}
	$("meta").textContent = Object.keys(d.dirs).length + " dirs, " + d.files.length + " files";
	body.appendChild(ul);
}

function showFile(/** @type {number} */ mine) {
	const body = $("body");
	body.replaceChildren(el("div", "note", "loading…"));
	$("meta").textContent = "";
	api("/blob?path=" + encodeURIComponent(current)).then(
		(f) => {
			if (mine !== seq) return;
			$("meta").textContent = f.size + " bytes · " + f.hash.slice(0, 7);
			if (f.text == null) return void body.replaceChildren(el("div", "note", f.binary ? "binary file" : "file too large to show"));
			const table = el("table", "src");
			const lines = f.text.split("\n");
			if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			lines.forEach((/** @type {string} */ line, /** @type {number} */ i) => {
				const tr = el("tr");
				tr.append(el("td", "n", String(i + 1)), el("td", "", line));
				table.appendChild(tr);
			});
			body.replaceChildren(table);
		},
		() => {
			if (mine === seq) body.replaceChildren(el("div", "note", "not a file on trunk"));
		},
	);
}

// ── why ────────────────────────────────────────────────────────────────────

function renderAirspace() {
	const box = /** @type {HTMLElement} */ ($("airspace").querySelector("div"));
	box.replaceChildren();
	const here = occupants(current);
	if (!here.length) return void box.appendChild(el("div", "none", "nobody"));
	for (const p of here) {
		const div = el("div", "plan");
		div.style.borderColor = color(p.agent);
		const name = el("b", "", p.agent);
		name.style.color = color(p.agent);
		div.append(name, " ", el("span", "none", p.status), el("div", "", p.task));
		const claims = p.claims.filter((c) => reaches(c, current)).map((c) => c.path);
		div.appendChild(el("div", "", "claims " + claims.join(", ")));
		box.appendChild(div);
	}
}

function showWhy(/** @type {number} */ mine) {
	const box = /** @type {HTMLElement} */ ($("history").querySelector("div"));
	box.replaceChildren(el("div", "none", "loading…"));
	// The whole trunk has no /why; the state snapshot's recent lands stand in for it.
	const load = current === "" ? Promise.resolve(recent) : api("/why?limit=1000&path=" + encodeURIComponent(current));
	load.then(
		(/** @type {Land[]} */ lands) => {
			if (mine !== seq) return;
			box.replaceChildren();
			if (!lands.length) return void box.appendChild(el("div", "none", "no landed plan has touched this path yet"));
			for (const l of lands) box.appendChild(landEntry(l));
		},
		() => {
			if (mine === seq) box.replaceChildren(el("div", "none", "could not load history"));
		},
	);
}

function landEntry(/** @type {Land} */ l) {
	const div = el("div", "land");
	div.style.borderColor = color(l.agent);
	div.appendChild(el("div", "sum", l.summary));
	const by = el("div", "by");
	const agent = el("b", "", l.agent);
	agent.style.color = color(l.agent);
	const plan = el("a", "", "plan " + l.plan_id);
	plan.href = withKey("/repos/" + encodeURIComponent(REPO) + "/plans?id=" + encodeURIComponent(l.plan_id));
	const when = el("span", "", " · " + ago(l.landed_at) + " · ");
	when.title = new Date(l.landed_at).toLocaleString();
	by.append(agent, when, el("code", "", l.sha.slice(0, 7)), plan);
	div.append(by, el("div", "task", l.task));
	if (l.paths && current === "") div.appendChild(el("div", "paths", l.paths.join(" ")));
	const ev = evidence(l.evidence);
	if (ev) div.appendChild(ev);
	return div;
}

/** Evidence as a collapsible list: request/plan/checks first, then any other fields. */
function evidence(/** @type {any} */ e) {
	if (e == null || e === "") return null;
	const det = el("details");
	det.appendChild(el("summary", "", "evidence"));
	const dl = el("dl");
	if (typeof e !== "object") dl.appendChild(el("dd", "", String(e)));
	else {
		const keys = Object.keys(e).sort((a, b) => order(a) - order(b));
		for (const k of keys) {
			const v = e[k];
			dl.append(el("dt", "", k), el("dd", "", typeof v === "string" ? v : JSON.stringify(v, null, 2)));
		}
	}
	det.appendChild(dl);
	return det;
}

function order(/** @type {string} */ k) {
	const i = ["request", "plan", "checks"].indexOf(k);
	return i < 0 ? 3 : i;
}

// ── live feed ──────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout> | undefined} */
let treeTimer;

/** @param {{ plans: Plan[], lands: Land[] }} s */
function setState(s) {
	plans = {};
	for (const p of s.plans) plans[p.id] = p;
	recent = s.lands;
}

// The first view loads over HTTP, so it never waits on the live feed; the feed keeps it current.
Promise.all([api("/state").then(setState), loadTree()]).then(show, () => {
	$("body").replaceChildren(el("div", "note", "could not load trunk (is ?key= set?)"));
});

live((ev) => {
	if (ev.type === "state") {
		setState(ev.state);
		renderTree();
		renderAirspace();
	} else if (ev.plan) {
		/** @type {Plan} */
		const p = ev.plan;
		if (p.status === "holding" || p.status === "cleared") plans[p.id] = p;
		else delete plans[p.id];
		if (ev.type === "landed") {
			recent.unshift({ sha: ev.sha, plan_id: p.id, agent: p.agent, task: p.task, summary: ev.summary || p.task, evidence: null, landed_at: ev.at, paths: ev.paths });
			// Trunk moved: refresh the tree, and the open view if the land touched it.
			clearTimeout(treeTimer);
			treeTimer = setTimeout(() => {
				const touched = current === "" || ev.paths.some((/** @type {string} */ x) => x === current || (current.endsWith("/") && x.startsWith(current)));
				loadTree().then(() => (touched ? show() : undefined));
			}, 1000);
		}
		renderTree();
		renderAirspace();
	}
});
