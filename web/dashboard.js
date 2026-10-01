// @ts-check
// The live dashboard at /repos/:repo/dashboard: subscribes to the live feed and draws the
// trunk as a treemap, with each in-flight agent as a colored region over its claims, holding
// plans queued behind their blockers, drift flashing red on the offending paths, lands
// streaming into a trunk timeline, and the headline counters.

import { $, KEY, REPO, api, color, el, live, nav } from "./client.js";

/** @typedef {{ path: string, dir: boolean }} Claim */
/** @typedef {{ id: string, agent: string, task: string, status: string, claims: Claim[], blockedBy: string[], fork?: string, createdAt: number }} Plan */
/** @typedef {{ sha: string, planId: string, agent: string, summary: string, paths: string[], at: number }} Land */
/** @typedef {{ name: string, path: string, dir: boolean, children: Record<string, TreeNode>, size: number, list: TreeNode[] }} TreeNode */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

const STATS = ["conflicts_prevented", "drift_blocked", "landed"];

/** @type {Record<string, Plan>} every plan seen this session, by id (landed/released kept for names) */
let plans = {};
/** @type {Land[]} oldest first */
let lands = [];
/** @type {Record<string, number>} */
let stats = {};
/** @type {string[]} files on trunk HEAD */
let treePaths = [];
/** @type {Record<string, boolean>} paths seen in claims, lands and drift but not (yet) on trunk */
let extra = {};
/** @type {Record<string, Rect>} node path ("src/", "src/a.ts") -> rect */
let rects = {};

nav();
$("repo").textContent = REPO;

/** @param {string} planId */
function agentOf(planId) { return plans[planId] ? plans[planId].agent : planId; }
/** @param {Plan} p */
function active(p) { return p.status === "cleared" || p.status === "holding"; }
/** @param {Rect} r */
function box(r) { return "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px"; }

// ── live feed ──────────────────────────────────────────────────────────────

/** @param {string} cls @param {string} text */
function setConn(cls, text) { $("conn").className = cls; $("conn").textContent = text; }

/** @param {any} ev */
function handle(ev) {
	if (ev.type === "state") {
		plans = {};
		ev.state.plans.forEach(/** @param {Plan} p */ (p) => { plans[p.id] = p; });
		lands = ev.state.lands.slice().reverse().map(/** @param {any} l */ (l) => ({
			sha: l.sha, planId: l.plan_id, agent: l.agent, summary: l.summary, paths: l.paths || [], at: l.landed_at,
		}));
		stats = Object.assign({}, ev.state.stats);
		renderCounters();
		renderTimeline();
		loadTree();
	} else if (ev.type === "drift") {
		logEntry("drift", agentOf(ev.planId) + " drifted: ", ev.paths);
		if (addPaths(ev.paths)) layout();
		flash(ev.paths, "drift", "DRIFT " + agentOf(ev.planId));
	} else if (ev.plan) {
		// Plan lifecycle events (filed, holding, cleared, amended, landed, released...) carry
		// the plan as it now stands.
		/** @type {Plan} */
		const plan = ev.plan;
		plans[plan.id] = plan;
		if (ev.type === "holding") logEntry("", plan.agent + " holding behind " + ev.blockedBy.map(agentOf).join(", "));
		else if (ev.type === "cleared") logEntry("", plan.agent + " cleared");
		else if (ev.type === "released") logEntry("", plan.agent + " released");
		else if (ev.type === "amended") logEntry("", plan.agent + " amended: ", ev.added);
		else if (ev.type === "deadlock") logEntry("drift", plan.agent + " refused (deadlock): ", ev.paths);
		if (ev.type === "landed") {
			lands.push({ sha: ev.sha, planId: plan.id, agent: plan.agent, summary: ev.summary || plan.task, paths: ev.paths, at: ev.at });
			logEntry("land", plan.agent + " landed ", [ev.sha.slice(0, 7)]);
			renderTimeline();
			if (addPaths(ev.paths)) layout();
			flash(ev.paths, "land", "LANDED " + plan.agent);
			loadTreeSoon();
		}
		if (addPaths(plan.claims.map((c) => c.path))) layout();
		else renderOverlay();
	} else if (ev.type === "stat") {
		stats[ev.key] = (stats[ev.key] || 0) + 1;
		renderCounters(ev.key);
	} else if (ev.type === "reset") {
		plans = {}; lands = []; stats = {}; extra = {}; treePaths = [];
		renderCounters(); renderTimeline(); layout();
		loadTreeSoon();
	}
	renderPlans();
}

// ── codebase map ───────────────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout> | undefined} */
let treeTimer;
function loadTreeSoon() { clearTimeout(treeTimer); treeTimer = setTimeout(loadTree, 1500); }
function loadTree() {
	api("/tree")
		.catch(() => null)
		.then((t) => {
			if (t) treePaths = t.paths;
			lands.forEach((l) => { addPaths(l.paths); });
			Object.keys(plans).forEach((id) => { addPaths(plans[id].claims.map((c) => c.path)); });
			layout();
		})
		.catch(() => { layout(); });
}

/**
 * Returns true when a path is new to the map, so the caller re-lays it out.
 * @param {string[]} paths
 */
function addPaths(paths) {
	/** @type {Record<string, boolean>} */
	const known = {};
	treePaths.forEach((p) => { known[p] = true; });
	let added = false;
	paths.forEach((p) => {
		if (known[p] || extra[p] || rects[p]) return;
		extra[p] = true;
		added = true;
	});
	return added;
}

/** @param {string} name @param {string} path @param {boolean} dir @returns {TreeNode} */
function node(name, path, dir) { return { name, path, dir, children: {}, size: 0, list: [] }; }

function buildTree() {
	const root = node(REPO, "", true);
	treePaths.concat(Object.keys(extra)).forEach((p) => {
		const parts = p.split("/");
		const isDir = p.charAt(p.length - 1) === "/";
		if (isDir) parts.pop();
		let n = root;
		for (let i = 0; i < parts.length; i++) {
			const last = i === parts.length - 1;
			const dir = !last || isDir;
			const key = parts[i] + (dir ? "/" : "");
			if (!n.children[key]) n.children[key] = node(parts[i], parts.slice(0, i + 1).join("/") + (dir ? "/" : ""), dir);
			n = n.children[key];
		}
	});
	/** @param {TreeNode} n @returns {number} */
	function size(n) {
		const kids = Object.keys(n.children).map((k) => n.children[k]);
		n.size = n.dir ? Math.max(1, kids.reduce((s, k) => s + size(k), 0)) : 1;
		n.list = kids;
		return n.size;
	}
	size(root);
	return root;
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk).
 * @param {TreeNode[]} items @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {(Rect & { item: TreeNode })[]} out
 */
function squarify(items, x, y, w, h, out) {
	const total = items.reduce((s, it) => s + it.size, 0);
	if (!total || w <= 0 || h <= 0) return;
	const scale = (w * h) / total;
	/** @typedef {{ item: TreeNode, area: number }} Cell */
	const rest = items.slice().sort((a, b) => b.size - a.size).map((it) => ({ item: it, area: it.size * scale }));
	/** @type {Cell[]} */
	let row = [];
	/** @param {Cell[]} r @param {number} side */
	function worst(r, side) {
		let s = 0, max = 0, min = Infinity;
		r.forEach((c) => { s += c.area; max = Math.max(max, c.area); min = Math.min(min, c.area); });
		return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
	}
	/** @param {Cell[]} r */
	function place(r) {
		const s = r.reduce((a, c) => a + c.area, 0);
		if (w >= h) {
			const cw = s / h;
			let cy = y;
			r.forEach((c) => { const ch = c.area / cw; out.push({ item: c.item, x, y: cy, w: cw, h: ch }); cy += ch; });
			x += cw; w -= cw;
		} else {
			const rh = s / w;
			let cx = x;
			r.forEach((c) => { const cw2 = c.area / rh; out.push({ item: c.item, x: cx, y, w: cw2, h: rh }); cx += cw2; });
			y += rh; h -= rh;
		}
	}
	while (rest.length) {
		const side = Math.min(w, h);
		if (!row.length || worst(row.concat([rest[0]]), side) <= worst(row, side)) row.push(/** @type {Cell} */ (rest.shift()));
		else { place(row); row = []; }
	}
	if (row.length) place(row);
}

function layout() {
	const tree = $("tree");
	tree.textContent = "";
	rects = {};
	const root = buildTree();
	$("empty").style.display = root.list.length ? "none" : "flex";
	const W = tree.clientWidth, H = tree.clientHeight;
	rects[""] = { x: 0, y: 0, w: W, h: H };
	/** @param {TreeNode} n @param {number} x @param {number} y @param {number} w @param {number} h */
	function draw(n, x, y, w, h) {
		/** @type {(Rect & { item: TreeNode })[]} */
		const out = [];
		squarify(n.list, x, y, w, h, out);
		out.forEach((r) => {
			rects[r.item.path] = { x: r.x, y: r.y, w: r.w, h: r.h };
			const e = el("div", r.item.dir ? "dir" : "file");
			e.style.cssText = box(r);
			e.title = r.item.path;
			if (r.w > 28 && r.h > 12) e.appendChild(el("label", "", r.item.name + (r.item.dir ? "/" : "")));
			tree.appendChild(e);
			if (r.item.dir) {
				const head = r.h > 30 && r.w > 30 ? 14 : 2;
				if (r.w > 6 && r.h > head + 4) draw(r.item, r.x + 2, r.y + head, r.w - 4, r.h - head - 2);
			}
		});
	}
	draw(root, 0, 0, W, H);
	renderOverlay();
}

/**
 * The rect for a path, or its nearest ancestor on the map.
 * @param {string} path
 * @returns {Rect | null}
 */
function rectFor(path) {
	let p = path;
	while (true) {
		if (rects[p]) return rects[p];
		if (p.charAt(p.length - 1) !== "/" && rects[p + "/"]) return rects[p + "/"];
		if (!p) return null;
		const trimmed = p.replace(/\/$/, "");
		const i = trimmed.lastIndexOf("/");
		p = i < 0 ? "" : trimmed.slice(0, i + 1);
	}
}

function renderOverlay() {
	const ov = $("overlay");
	ov.querySelectorAll(".claim, .dot").forEach((e) => { e.remove(); });
	Object.keys(plans).map((id) => plans[id]).filter(active).forEach((p) => {
		const c = color(p.agent);
		/** @type {Rect | null} */
		let first = null;
		p.claims.forEach((claim) => {
			const r = rectFor(claim.path);
			if (!r) return;
			if (!first) first = r;
			const e = el("div", "claim " + p.status);
			e.style.cssText = box(r) + ";border-color:" + c + ";background:" + c.replace("hsl", "hsla").replace(")", ", .22)");
			ov.appendChild(e);
		});
		if (!first) return;
		/** @type {Rect} */
		const f = first;
		const d = el("div", "dot " + p.status);
		d.style.cssText = "left:" + (f.x + f.w / 2) + "px;top:" + (f.y + f.h / 2) + "px;color:" + c;
		d.appendChild(el("i"));
		d.appendChild(el("span", "", p.agent + (p.status === "holding" ? " ⏳" : "")));
		ov.appendChild(d);
	});
}

/** @param {string[]} paths @param {string} kind @param {string} label */
function flash(paths, kind, label) {
	const ov = $("overlay");
	/** @type {Record<string, boolean>} */
	const seen = {};
	paths.forEach((path, i) => {
		const r = rectFor(path);
		if (!r) return;
		const k = r.x + "," + r.y;
		if (seen[k]) return;
		seen[k] = true;
		const e = el("div", "flash " + kind);
		e.style.cssText = box(r);
		if (i === 0 && r.w > 60 && r.h > 14) e.appendChild(el("em", "", label));
		ov.appendChild(e);
		setTimeout(() => { e.remove(); }, 2500);
	});
}

// ── panels ────────────────────────────────────────────────────────────────

/** @param {Claim} a @param {Claim} b */
function overlaps(a, b) {
	if (a.path === b.path) return true;
	if (a.dir && b.path.indexOf(a.path) === 0) return true;
	if (b.dir && a.path.indexOf(b.path) === 0) return true;
	return false;
}

/**
 * A holding plan's blockedBy can go stale (only newly cleared plans are rebroadcast),
 * so blockers are recomputed from the plans active right now, as the Tower does.
 * @param {Plan} p @param {Plan[]} all
 */
function blockers(p, all) {
	return all.filter((q) =>
		q.id !== p.id && (q.status === "cleared" || q.createdAt < p.createdAt) &&
		q.claims.some((a) => p.claims.some((b) => overlaps(a, b))));
}

/** The list under a panel's <h2>. @param {string} id */
function panel(id) { return /** @type {HTMLElement} */ ($(id).lastElementChild); }

function renderPlans() {
	const all = Object.keys(plans).map((id) => plans[id]).filter(active).sort((a, b) => a.createdAt - b.createdAt);
	const flying = panel("flying"), holding = panel("holding");
	flying.textContent = ""; holding.textContent = "";
	all.forEach((p) => {
		const row = el("div", "plan");
		row.style.borderColor = color(p.agent);
		row.appendChild(el("b", "", p.agent));
		row.appendChild(el("div", "", p.task));
		const claims = el("div");
		claims.appendChild(el("code", "", p.claims.map((c) => c.path).join("  ")));
		row.appendChild(claims);
		if (p.status === "holding") {
			const names = blockers(p, all).map((q) => q.agent);
			row.appendChild(el("div", "", "⏳ waiting on " + (names.join(", ") || "clearance")));
			holding.appendChild(row);
		} else flying.appendChild(row);
	});
	if (!flying.childNodes.length) flying.appendChild(el("div", "none", "no agents in flight"));
	if (!holding.childNodes.length) holding.appendChild(el("div", "none", "nobody waiting"));
}

/** @param {string} kind @param {string} text @param {string[]} [paths] */
function logEntry(kind, text, paths) {
	const list = panel("log");
	const e = el("div", "entry " + kind);
	e.appendChild(el("b", "", text));
	if (paths) e.appendChild(el("code", "", paths.join(", ")));
	list.insertBefore(e, list.firstChild);
	while (list.childNodes.length > 60) list.lastChild?.remove();
}

/** @param {string} [bumped] */
function renderCounters(bumped) {
	STATS.forEach((k) => {
		const c = $("c-" + k);
		/** @type {Element} */ (c.firstElementChild).textContent = String(stats[k] || 0);
		if (k === bumped) { c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); }
	});
}

function renderTimeline() {
	const t = $("trunk");
	/** @type {Record<string, HTMLElement>} */
	const shown = {};
	for (const n of /** @type {HTMLCollectionOf<HTMLElement>} */ (t.children)) if (n.dataset.sha) shown[n.dataset.sha] = n;
	if (!lands.length) { t.textContent = ""; t.appendChild(el("div", "none", "nothing landed yet")); return; }
	t.querySelectorAll(".none").forEach((n) => { n.remove(); });
	/** @type {Record<string, boolean>} */
	const keep = {};
	lands.slice(-40).forEach((l) => {
		keep[l.sha] = true;
		if (shown[l.sha]) return;
		const c = el("div", "commit");
		c.dataset.sha = l.sha;
		c.style.borderTopColor = color(l.agent);
		c.appendChild(el("code", "", l.sha.slice(0, 7)));
		c.appendChild(el("b", "", l.agent));
		c.appendChild(el("div", "", l.summary));
		c.appendChild(el("div", "", l.paths.length + " file" + (l.paths.length === 1 ? "" : "s") + " · " + new Date(l.at).toLocaleTimeString()));
		c.title = l.paths.join("\n");
		t.appendChild(c);
	});
	for (const n of Array.from(/** @type {HTMLCollectionOf<HTMLElement>} */ (t.children))) if (!keep[n.dataset.sha || ""]) n.remove();
	t.scrollLeft = t.scrollWidth;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 150); });

renderCounters(); renderPlans(); renderTimeline();
live(handle, (status) => {
	if (status === "live") setConn("live", "live");
	else setConn("down", KEY ? "reconnecting…" : "no ?key= in URL");
});
