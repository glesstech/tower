// @ts-check
// The live dashboard at /repos/:repo/dashboard, in two views over one model (web/model.js):
//
// - Operator (default): in-flight plans with their task, claims (and their coverage of trunk,
//   broad claims forced past tower's refusal highlighted), fork and running time;
//   holding plans with who they wait on for which paths; held amendments and deadlock
//   refusals; lands with their files and the agent's evidence (collapsed); and an event feed
//   with drift rejections and their paths. Click any path for its /why.
// - Map (?view=map), for demos: trunk as a treemap with labeled regions, each in-flight agent
//   as a colored, named region over its claims, recent lands outlined, a legend and the trunk
//   timeline.
//
// Replay loads the trunk's event log (or a downloaded one) and plays it back through the same
// model, so a finished run still tells its story.
//
// Built to stay readable with hundreds of plans: a throughput strip (lands/min, queue depth,
// agents in flight) sits above both views; events are applied at once but drawn at most once
// per frame; the operator lists show the oldest rows and summarize the rest (holding plans as
// one line per contested path); and a crowded map drops per-agent labels and shows each
// path's queue as a count.

import { $, KEY, REPO, api, color, el, failure, fatal, live, nav, withKey } from "./client.js";
import {
	activePlans, amendmentOn, apply, applyState, behindBroad, coverageText, createModel, firstLine, holdingOn, queues, remember,
	replayDelays, sample, shortName, throughput, tint, toLand,
} from "./model.js";

/** @typedef {import("./model.js").Plan} Plan */
/** @typedef {import("./model.js").Land} Land */
/** @typedef {import("./model.js").Wait} Wait */
/** @typedef {{ name: string, path: string, dir: boolean, depth: number, children: Record<string, TreeNode>, size: number, list: TreeNode[] }} TreeNode */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

const STATS = ["conflicts_prevented", "drift_blocked", "deadlocks_prevented", "claims_forced", "blocked_by_broad", "landed"];
const VIEW = new URLSearchParams(location.search).get("view") === "map" ? "map" : "ops";
const BACKFILL = 500;
/** Rows drawn per operator list; the rest are summarized. */
const ROWS = 40;
/** Above this many active plans the map is "dense": smaller dots, no names, queue counts. */
const DENSE = 40;

let m = createModel();
/** @type {Record<string, unknown>} evidence by land sha; live "landed" events don't carry it */
const evidence = {};
/** @type {string[]} files on trunk HEAD */
let treePaths = [];
/** @type {Record<string, boolean>} paths seen in claims, lands and drift but not (yet) on trunk */
let extra = {};
/** @type {Record<string, Rect>} node path ("src/", "src/a.ts") -> rect */
let rects = {};

/** @type {{ timer: ReturnType<typeof setTimeout> | undefined, now: number } | null} set while replaying */
let replay = null;

const bar = nav();
$("repo").textContent = REPO;
document.body.classList.add("view-" + VIEW);
/** @type {HTMLAnchorElement} */ ($("v-ops")).href = withKey(location.pathname);
/** @type {HTMLAnchorElement} */ ($("v-map")).href = withKey(location.pathname + "?view=map");
$("v-" + VIEW).classList.add("active");

/** The clock running times are measured against: the replayed moment while replaying. */
function now() { return replay ? replay.now : Date.now(); }

/** "42s", "3m 05s", "1h 02m". @param {number} ms */
function dur(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return s + "s";
	if (s < 3600) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
	return Math.floor(s / 3600) + "h " + String(Math.floor(s / 60) % 60).padStart(2, "0") + "m";
}

/** @param {Rect} r */
function box(r) { return "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px"; }

/** A clickable path: opens /why for it. @param {string} path */
function pathEl(path) {
	const c = el("code", "path", path);
	c.dataset.path = path;
	c.title = "Why does " + path + " look like this?";
	return c;
}

/** An agent's name with its color. @param {string} agent */
function agentEl(agent) {
	const b = el("b", "agent", agent);
	b.style.setProperty("--c", color(agent));
	return b;
}

/** Paths as chips, folding the rest away after `max`. @param {string[]} paths @param {number} [max] */
function pathsEl(paths, max = 6) {
	const wrap = el("span", "paths");
	paths.slice(0, max).forEach((p) => { wrap.appendChild(pathEl(p)); });
	if (paths.length > max) {
		const more = el("details", "more");
		more.appendChild(el("summary", "", "+" + (paths.length - max) + " more"));
		paths.slice(max).forEach((p) => { more.appendChild(pathEl(p)); });
		wrap.appendChild(more);
	}
	return wrap;
}

/** "waiting on X for a, b; Y for c". @param {Wait[]} waits */
function waitsEl(waits) {
	const s = el("span", "waits");
	if (!waits.length) { s.textContent = "waiting for clearance"; return s; }
	s.appendChild(document.createTextNode("waiting on "));
	waits.forEach((w, i) => {
		if (i) s.appendChild(document.createTextNode("; "));
		s.appendChild(agentEl(w.plan.agent));
		s.appendChild(document.createTextNode(" for "));
		w.paths.forEach((p, j) => {
			if (j) s.appendChild(document.createTextNode(", "));
			s.appendChild(pathEl(p));
		});
	});
	return s;
}

// ── events in ──────────────────────────────────────────────────────────────

/** @param {string} cls @param {string} text */
function setConn(cls, text) { $("conn").className = cls; $("conn").textContent = text; }

/** A live event; ignored while a replay owns the model. @param {any} ev */
function handle(ev) {
	if (!replay) step(ev);
}

/** Applies one event to the model and the views. @param {any} ev */
function step(ev) {
	if (ev.type === "state") {
		applyState(m, ev.state);
		m.lands.forEach((l) => { if (l.evidence !== undefined) evidence[l.sha] = l.evidence; });
		renderAll();
		loadTree();
		if (!replay) backfill(ev.state.seq || 0);
		return;
	}
	if (ev.type === "reset") {
		m = createModel();
		extra = {}; treePaths = [];
		renderAll(); layout();
		loadTreeSoon();
		return;
	}
	const land = apply(m, ev);
	if (ev.type === "drift") {
		if (addPaths(ev.paths || [])) layout();
		flash(ev.paths || [], "drift", (ev.blocked ? "REJECTED " : "DRIFT ") + (ev.agent || ""));
	}
	if (land) {
		if (addPaths(land.paths)) layout();
		flash(land.paths, "land", "LANDED " + land.agent);
		if (!replay) { loadTreeSoon(); evidenceSoon(); }
	}
	if (ev.plan && addPaths(ev.plan.claims.map(/** @param {{ path: string }} c */ (c) => c.path))) layout();
	if (ev.type === "stat") renderCounters(ev.key);
	renderSoon();
}

let frame = 0;
/** Draws on the next frame, once, however many events arrive before it. */
function renderSoon() {
	if (frame) return;
	frame = requestAnimationFrame(() => { frame = 0; renderAll(); });
}

/** The feed's history from before the snapshot: drift, deadlocks, clear times. @param {number} seq */
function backfill(seq) {
	api("/events?since=" + Math.max(0, seq - BACKFILL) + "&limit=" + BACKFILL)
		.then((r) => {
			if (replay) return;
			r.events.filter(/** @param {any} e */ (e) => e.seq <= seq).forEach(/** @param {any} e */ (e) => { remember(m, e); });
			renderAll();
		})
		.catch(() => {});
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let evidenceTimer;
/** Live lands carry no evidence; the snapshot does. */
function evidenceSoon() {
	clearTimeout(evidenceTimer);
	evidenceTimer = setTimeout(() => {
		api("/state")
			.then((s) => {
				s.lands.forEach(/** @param {any} l */ (l) => { evidence[l.sha] = l.evidence; });
				renderLands();
			})
			.catch(() => {});
	}, 1200);
}

// ── replay ─────────────────────────────────────────────────────────────────

/** Every event in the trunk's log, a page at a time. */
async function loadEvents() {
	/** @type {any[]} */
	const all = [];
	let since = 0;
	for (;;) {
		const r = await api("/events?since=" + since + "&limit=10000");
		if (!r.events.length) break;
		all.push(...r.events);
		since = r.last;
	}
	return all;
}

/** @param {string} text */
function replayStatus(text) { $("r-status").textContent = text; }

/** Plays `events` back from an empty model. @param {any[]} events @param {any[]} lands land rows with evidence */
function startReplay(events, lands) {
	stopTimer();
	lands.forEach((l) => { evidence[l.sha] = l.evidence; });
	if (!events.length) { replayStatus("no events to replay"); return; }
	replay = { timer: undefined, now: events[0].at };
	m = createModel();
	extra = {};
	setConn("replay", "replaying");
	$("r-stop").hidden = false;
	renderAll(); layout();
	const speed = Number(/** @type {HTMLSelectElement} */ ($("r-speed")).value) || 4;
	const delays = replayDelays(events, speed);
	let i = 0;
	const next = () => {
		if (!replay) return;
		const ev = events[i];
		replay.now = ev.at;
		step(ev);
		i++;
		replayStatus("replay " + i + "/" + events.length + " · " + new Date(ev.at).toLocaleTimeString());
		if (i < events.length) replay.timer = setTimeout(next, delays[i]);
		else replayStatus("replay finished · " + events.length + " events");
	};
	replay.timer = setTimeout(next, 300);
}

function stopTimer() { if (replay) clearTimeout(replay.timer); }

function stopReplay() {
	stopTimer();
	replay = null;
	m = createModel();
	extra = {};
	$("r-stop").hidden = true;
	replayStatus("");
	setConn("", "loading");
	api("/state")
		.then((s) => { setConn("live", "live"); step({ type: "state", state: s }); })
		.catch(() => { setConn("down", "can't reach the trunk"); renderAll(); });
}

$("r-play").addEventListener("click", () => {
	replayStatus("loading events…");
	Promise.all([loadEvents(), api("/state").catch(() => ({ lands: [] }))])
		.then(([events, s]) => { startReplay(events, s.lands); })
		.catch((err) => { replayStatus("can't load events: " + err.message); });
});
$("r-stop").addEventListener("click", stopReplay);
$("r-save").addEventListener("click", () => {
	replayStatus("saving…");
	Promise.all([loadEvents(), api("/state")])
		.then(([events, state]) => {
			const blob = new Blob([JSON.stringify({ repo: REPO, savedAt: Date.now(), state, events })], { type: "application/json" });
			const a = el("a");
			a.href = URL.createObjectURL(blob);
			a.download = "tower-" + REPO + "-events.json";
			a.click();
			URL.revokeObjectURL(a.href);
			replayStatus("saved " + events.length + " events");
		})
		.catch((err) => { replayStatus("can't save: " + err.message); });
});
$("r-load").addEventListener("change", (e) => {
	const input = /** @type {HTMLInputElement} */ (e.target);
	const file = input.files?.[0];
	if (!file) return;
	file.text()
		.then((text) => {
			const data = JSON.parse(text);
			if (!Array.isArray(data.events)) throw new Error("no events in file");
			startReplay(data.events, data.state?.lands || []);
		})
		.catch((err) => { replayStatus("can't replay file: " + err.message); })
		.finally(() => { input.value = ""; });
});

// ── operator view ──────────────────────────────────────────────────────────

/** The list under a section's <h2>. @param {string} id */
function panel(id) { return /** @type {HTMLElement} */ ($(id).lastElementChild); }

/** @param {HTMLElement} list @param {string} text */
function empty(list, text) { list.appendChild(el("div", "none", text)); }

function renderAll() {
	renderCounters();
	renderPulse();
	if (VIEW === "ops") { renderPlans(); renderLands(); renderFeed(); }
	else { renderOverlay(); renderTimeline(); }
}

// ── throughput strip ───────────────────────────────────────────────────────

const SPARK_W = 200, SPARK_H = 32;

/**
 * One measure as a small chart: bars (counts per bucket) or a line (a level over time), each
 * bucket a hover target with its time and value.
 * @param {number[]} values @param {"bars" | "line"} kind @param {string} c @param {number} start @param {number} bucketMs @param {string} unit
 */
function sparkSvg(values, kind, c, start, bucketMs, unit) {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 " + SPARK_W + " " + SPARK_H);
	svg.setAttribute("preserveAspectRatio", "none");
	svg.style.setProperty("--c", c);
	const n = values.length, step = SPARK_W / n, top = Math.max(1, ...values);
	const y = (/** @type {number} */ v) => SPARK_H - 1 - (v / top) * (SPARK_H - 3);
	/** @param {string} tag @param {Record<string, string | number>} attrs */
	const add = (tag, attrs) => {
		const e = document.createElementNS(NS, tag);
		Object.entries(attrs).forEach(([k, v]) => { e.setAttribute(k, String(v)); });
		svg.appendChild(e);
		return e;
	};
	add("line", { class: "base", x1: 0, x2: SPARK_W, y1: SPARK_H - 0.5, y2: SPARK_H - 0.5 });
	if (kind === "bars") {
		values.forEach((v, i) => { if (v) add("rect", { class: "bar", x: i * step + 1, y: y(v), width: Math.max(1, step - 2), height: SPARK_H - 1 - y(v), rx: 1 }); });
	} else {
		add("polyline", { class: "trace", points: values.map((v, i) => (i * step + step / 2).toFixed(1) + "," + y(v).toFixed(1)).join(" ") });
	}
	values.forEach((v, i) => {
		const hit = add("rect", { class: "hit", x: i * step, y: 0, width: step, height: SPARK_H });
		const t = document.createElementNS(NS, "title");
		t.textContent = new Date(start + i * bucketMs).toLocaleTimeString() + " · " + Math.round(v) + " " + unit;
		hit.appendChild(t);
	});
	return svg;
}

function renderPulse() {
	const t = throughput(m, now());
	const pulse = $("pulse");
	pulse.textContent = "";
	/** @param {string} label @param {number} value @param {number} peak @param {number[]} values @param {"bars" | "line"} kind @param {string} c @param {string} unit */
	const tile = (label, value, peak, values, kind, c, unit) => {
		const box = el("div", "spark");
		const v = el("div", "v");
		v.appendChild(el("b", "", String(Math.round(value))));
		v.appendChild(el("span", "", label));
		v.appendChild(el("small", "", "peak " + Math.round(peak)));
		box.appendChild(v);
		box.appendChild(sparkSvg(values, kind, c, t.start, t.bucketMs, unit));
		pulse.appendChild(box);
	};
	tile("lands / min", t.now.landsPerMin, t.peak.landsPerMin, t.lands, "bars", "var(--green)", "lands/min");
	tile("queue depth", t.now.holding, t.peak.holding, t.holding, "line", "#d29922", "holding");
	tile("agents in flight", t.now.flying, t.peak.flying, t.flying, "line", "hsl(210, 85%, 62%)", "in flight");
}

// Keep the strip moving through quiet stretches (and sample levels that no event announced).
setInterval(() => {
	if (!replay) sample(m, Date.now());
	renderPulse();
}, 2000);

/** "+N more" under a list cut at ROWS. @param {HTMLElement} list @param {number} more @param {string} what */
function moreRows(list, more, what) {
	if (more > 0) list.appendChild(el("div", "more-rows", "+" + more + " more " + what));
}

function renderPlans() {
	const all = activePlans(m);
	const flying = panel("flying"), holding = panel("holding");
	flying.textContent = ""; holding.textContent = "";
	const nFlying = all.filter((p) => p.status === "cleared").length;
	const nHolding = all.length - nFlying;
	// With a long line, lead with where it is: each contested path and how many wait on it.
	if (nHolding > ROWS / 4) {
		queues(all).slice(0, 8).forEach((q) => {
			const r = el("div", "queue");
			r.appendChild(el("b", "", String(q.count)));
			r.appendChild(pathsEl(q.paths, 2));
			r.appendChild(el("span", "dim", "next: " + q.next.map((p) => p.agent).join(", ")));
			holding.appendChild(r);
		});
	}
	let shownFlying = 0, shownHolding = 0;
	all.forEach((p) => {
		if (p.status === "holding" ? shownHolding++ >= ROWS : shownFlying++ >= ROWS) return;
		const row = el("div", "plan " + p.status);
		row.style.setProperty("--c", color(p.agent));
		const head = el("div", "head");
		head.appendChild(agentEl(p.agent));
		const t = el("span", "task", firstLine(p.task));
		t.title = p.task;
		head.appendChild(t);
		const time = el("span", "time");
		time.dataset.since = String(p.status === "cleared" ? m.clearedAt[p.id] || p.createdAt : p.createdAt);
		time.textContent = dur(now() - Number(time.dataset.since));
		time.title = p.status === "cleared" ? "in flight for" : "waiting for";
		head.appendChild(time);
		row.appendChild(head);

		const claims = el("div", "line");
		claims.appendChild(el("span", "k", "claims"));
		claims.appendChild(pathsEl(p.claims.map((c) => c.path)));
		row.appendChild(claims);
		const h = m.hygiene[p.id];
		if (h) {
			// Coverage of trunk, and the broad paths this plan forced past tower's refusal.
			const cov = el("div", "line" + (h.forced.length ? " forced" : ""));
			cov.appendChild(el("span", "k", "covers"));
			cov.appendChild(el("span", "", h.coverage ? coverageText(h.coverage) : "not measured"));
			if (h.forced.length) {
				cov.appendChild(document.createTextNode(" · forced broad claim "));
				cov.appendChild(pathsEl(h.forced));
				row.classList.add("forced");
			}
			row.appendChild(cov);
		}

		if (p.status === "holding") {
			const w = el("div", "line" + (behindBroad(m, p, all) ? " forced" : ""));
			w.appendChild(el("span", "k", "⏳"));
			w.appendChild(waitsEl(holdingOn(p, all)));
			if (behindBroad(m, p, all)) w.appendChild(document.createTextNode(" (behind a broad claim)"));
			row.appendChild(w);
			holding.appendChild(row);
			return;
		}
		const fork = el("div", "line");
		fork.appendChild(el("span", "k", "fork"));
		fork.appendChild(p.fork ? el("code", "", p.fork) : el("span", "dim", "provisioning…"));
		row.appendChild(fork);
		if (p.amendment) {
			const a = el("div", "line held");
			a.appendChild(el("span", "k", "amend"));
			a.appendChild(pathsEl(p.amendment.claims.map((c) => c.path)));
			a.appendChild(document.createTextNode(" held, "));
			a.appendChild(waitsEl(amendmentOn(p, all)));
			row.appendChild(a);
		}
		const dl = m.deadlocks[p.id];
		if (dl) {
			const d = el("div", "line refused");
			d.appendChild(el("span", "k", "refused"));
			d.appendChild(pathsEl(dl.paths));
			d.appendChild(document.createTextNode(" deadlock: " + dl.cycle.map((id) => m.names[id] || id).join(" → ")));
			row.appendChild(d);
		}
		flying.appendChild(row);
	});
	moreRows(flying, nFlying - ROWS, "in flight, oldest first above");
	moreRows(holding, nHolding - ROWS, "holding, counted per path above");
	if (!flying.childNodes.length) empty(flying, replay ? "No agents in flight at this point of the replay." : "No agents in flight. Start a swarm or sim to see activity.");
	if (!holding.childNodes.length) empty(holding, "Nobody waiting. Plans queue here when they claim paths another agent holds.");
	/** @type {HTMLElement} */ ($("flying").firstElementChild).textContent = "In flight · " + nFlying;
	/** @type {HTMLElement} */ ($("holding").firstElementChild).textContent = "Holding · " + nHolding;
}

/** An agent's evidence, rendered as text only. @param {unknown} ev */
function evidenceEl(ev) {
	const out = el("div", "evidence");
	if (ev === undefined) { out.appendChild(el("span", "dim", "loading…")); return out; }
	if (ev === null || ev === "") { out.appendChild(el("span", "dim", "none given")); return out; }
	if (typeof ev === "object" && !Array.isArray(ev)) {
		Object.entries(/** @type {Record<string, unknown>} */ (ev)).forEach(([k, v]) => {
			out.appendChild(el("h3", "", k));
			out.appendChild(el("pre", "", typeof v === "string" ? v : JSON.stringify(v, null, 2)));
		});
		return out;
	}
	out.appendChild(el("pre", "", typeof ev === "string" ? ev : JSON.stringify(ev, null, 2)));
	return out;
}

/** A land with its files and (collapsed) evidence. @param {Land} l */
function landEl(l) {
	const row = el("div", "land");
	row.style.setProperty("--c", color(l.agent));
	const head = el("div", "head");
	head.appendChild(agentEl(l.agent));
	head.appendChild(el("span", "task", l.summary));
	const sha = el("code", "sha", l.sha.slice(0, 7));
	sha.title = l.sha;
	head.appendChild(sha);
	head.appendChild(el("span", "time", new Date(l.at).toLocaleTimeString()));
	row.appendChild(head);
	if (l.paths.length) {
		const files = el("div", "line");
		files.appendChild(el("span", "k", l.paths.length + (l.paths.length === 1 ? " file" : " files")));
		files.appendChild(pathsEl(l.paths));
		row.appendChild(files);
	}
	const ev = el("details", "ev");
	ev.appendChild(el("summary", "", "evidence"));
	ev.addEventListener("toggle", () => {
		if (!ev.open || ev.childNodes.length > 1) return;
		ev.appendChild(evidenceEl(l.evidence !== undefined ? l.evidence : evidence[l.sha]));
	});
	row.appendChild(ev);
	return row;
}

function renderLands() {
	if (VIEW !== "ops") return;
	const list = panel("lands");
	/** @type {Record<string, boolean>} */
	const open = {};
	list.querySelectorAll("details.ev[open]").forEach((d) => { open[/** @type {HTMLElement} */ (d.parentElement).dataset.sha || ""] = true; });
	list.textContent = "";
	m.lands.slice(-50).reverse().forEach((l) => {
		const row = landEl(l);
		row.dataset.sha = l.sha;
		list.appendChild(row);
		if (open[l.sha]) { const d = /** @type {HTMLDetailsElement} */ (row.querySelector("details.ev")); d.open = true; }
	});
	if (!m.lands.length) empty(list, "Nothing landed yet. Lands show up here with their files and the agent's evidence.");
	/** @type {HTMLElement} */ ($("lands").firstElementChild).textContent = "Landed · " + m.lands.length;
}

function renderFeed() {
	const list = panel("log");
	list.textContent = "";
	m.feed.slice(-120).reverse().forEach((f) => {
		const e = el("div", "entry " + f.kind);
		e.appendChild(el("span", "time", new Date(f.at).toLocaleTimeString()));
		e.appendChild(agentEl(f.agent));
		e.appendChild(el("span", "text", f.text));
		if (f.paths.length) e.appendChild(pathsEl(f.paths, 4));
		list.appendChild(e);
	});
	if (!m.feed.length) empty(list, "No events yet. Plans filed, holds, drift and lands are listed here as they happen.");
}

/** @param {string} [bumped] */
function renderCounters(bumped) {
	STATS.forEach((k) => {
		const c = $("c-" + k);
		/** @type {Element} */ (c.firstElementChild).textContent = String(m.stats[k] || 0);
		if (k === bumped) { c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); }
	});
}

setInterval(() => {
	document.querySelectorAll("[data-since]").forEach((e) => {
		e.textContent = dur(now() - Number(/** @type {HTMLElement} */ (e).dataset.since));
	});
}, 1000);

// ── why ────────────────────────────────────────────────────────────────────

/** @param {string} path */
function openWhy(path) {
	$("why").hidden = false;
	$("why-path").textContent = path;
	const body = $("why-body");
	body.textContent = "";
	const dir = path.endsWith("/");
	const claimers = activePlans(m).filter((p) => p.claims.some((c) => c.path === path || (c.dir && path.startsWith(c.path)) || (dir && c.path.startsWith(path))));
	if (claimers.length) {
		const held = el("div", "claimed");
		held.appendChild(el("h3", "", "Claimed now"));
		claimers.forEach((p) => {
			const r = el("div", "line");
			r.appendChild(agentEl(p.agent));
			r.appendChild(el("span", "dim", " " + p.status + ": " + firstLine(p.task)));
			held.appendChild(r);
		});
		body.appendChild(held);
	}
	const list = el("div", "why-lands");
	list.appendChild(el("div", "dim", "loading…"));
	body.appendChild(list);
	/** @param {Land[]} lands @param {string} note */
	const show = (lands, note) => {
		list.textContent = "";
		list.appendChild(el("h3", "", "Landed changes"));
		if (note) list.appendChild(el("div", "note", note));
		lands.forEach((l) => { list.appendChild(landEl(l)); });
		if (!lands.length) empty(list, "Nothing has landed on this path yet.");
	};
	const local = () => m.lands.filter((l) => l.paths.some((p) => p === path || (dir && p.startsWith(path)) || p.startsWith(path + "/"))).reverse();
	if (replay) { show(local(), "From the replayed events."); return; }
	api("/why?path=" + encodeURIComponent(path))
		// /why rows carry no paths; take them from the lands this page has seen.
		.then((rows) => { show(rows.map(toLand).map(/** @param {Land} l */ (l) => ({ ...l, paths: m.lands.find((x) => x.sha === l.sha)?.paths || [] })), ""); })
		.catch(() => { show(local(), "This key can't read /why, so these are the lands this page has seen."); });
}

document.addEventListener("click", (e) => {
	const target = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest("[data-path]") : null);
	if (target?.dataset.path) openWhy(target.dataset.path);
});
$("why-close").addEventListener("click", () => { $("why").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("why").hidden = true; });

// ── map view ───────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout> | undefined} */
let treeTimer;
function loadTreeSoon() { clearTimeout(treeTimer); treeTimer = setTimeout(loadTree, 1500); }
function loadTree() {
	if (VIEW !== "map") return;
	api("/tree")
		.catch(() => null)
		.then((t) => {
			if (t) treePaths = t.paths;
			m.lands.forEach((l) => { addPaths(l.paths); });
			activePlans(m).forEach((p) => { addPaths(p.claims.map((c) => c.path)); });
			layout();
		})
		.catch(() => { layout(); });
}

/**
 * Returns true when a path is new to the map, so the caller re-lays it out.
 * @param {string[]} paths
 */
function addPaths(paths) {
	if (VIEW !== "map") return false;
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

/** @param {string} name @param {string} path @param {boolean} dir @param {number} depth @returns {TreeNode} */
function node(name, path, dir, depth) { return { name, path, dir, depth, children: {}, size: 0, list: [] }; }

function buildTree() {
	const root = node(REPO, "", true, 0);
	treePaths.concat(Object.keys(extra)).forEach((p) => {
		const parts = p.split("/");
		const isDir = p.charAt(p.length - 1) === "/";
		if (isDir) parts.pop();
		let n = root;
		for (let i = 0; i < parts.length; i++) {
			const last = i === parts.length - 1;
			const dir = !last || isDir;
			const key = parts[i] + (dir ? "/" : "");
			if (!n.children[key]) n.children[key] = node(parts[i], parts.slice(0, i + 1).join("/") + (dir ? "/" : ""), dir, i + 1);
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
	if (VIEW !== "map") return;
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
			// Top-level directories are the map's regions: bigger, brighter labels.
			const e = el("div", r.item.dir ? (r.item.depth === 1 ? "dir region" : "dir") : "file");
			e.style.cssText = box(r);
			e.title = r.item.path;
			e.dataset.path = r.item.path;
			if (r.w > 28 && r.h > 12) e.appendChild(el("label", "", r.item.name + (r.item.dir ? "/" : "")));
			tree.appendChild(e);
			if (r.item.dir) {
				const head = r.item.depth === 1 && r.h > 40 && r.w > 40 ? 20 : r.h > 30 && r.w > 30 ? 14 : 2;
				if (r.w > 6 && r.h > head + 4) draw(r.item, r.x + 3, r.y + head, r.w - 6, r.h - head - 3);
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

const RECENT_LANDS = 6;

function renderOverlay() {
	if (VIEW !== "map") return;
	const ov = $("overlay");
	ov.querySelectorAll(".claim, .dot, .landed, .badge").forEach((e) => { e.remove(); });

	// Recent lands stay outlined on the map, fading with age, so an idle map still shows
	// where the work went.
	/** @type {Record<string, boolean>} */
	const marked = {};
	m.lands.slice(-RECENT_LANDS).reverse().forEach((l, i) => {
		let labeled = false;
		l.paths.forEach((path) => {
			const r = rectFor(path);
			if (!r) return;
			const k = r.x + "," + r.y + "," + r.w;
			if (marked[k]) return;
			marked[k] = true;
			const e = el("div", "landed");
			e.style.cssText = box(r) + ";opacity:" + (1 - i / (RECENT_LANDS + 1)).toFixed(2) + ";--c:" + color(l.agent);
			if (!labeled && r.w > 50 && r.h > 14) { e.appendChild(el("em", "", "✓ " + shortName(l.agent) + " " + l.sha.slice(0, 7))); labeled = true; }
			ov.appendChild(e);
		});
	});

	const plans = activePlans(m);
	const dense = plans.length > DENSE;
	/** @type {Record<string, { r: Rect, n: number }>} holding plans per rect, when dense */
	const waiting = {};
	plans.forEach((p) => {
		const c = color(p.agent);
		if (dense && p.status === "holding") {
			// A crowd waiting on one file is one number on it, not a pile of dashed boxes.
			const r = p.claims.map((cl) => rectFor(cl.path)).find(Boolean);
			if (r) (waiting[r.x + "," + r.y + "," + r.w] ??= { r, n: 0 }).n++;
			return;
		}
		/** @type {Rect | null} */
		let first = null;
		p.claims.forEach((claim) => {
			const r = rectFor(claim.path);
			if (!r) return;
			if (!first) first = r;
			const e = el("div", "claim " + p.status);
			e.style.cssText = box(r) + ";border-color:" + c + ";background:" + tint(c, 0.22) + ";--c:" + c;
			// Every region names its agent, so color is never the only cue (the legend does when dense).
			if (!dense && r.w > 22 && r.h > 14) e.appendChild(el("span", "tag", r.w > p.agent.length * 7 + 12 ? p.agent : shortName(p.agent)));
			ov.appendChild(e);
		});
		if (!first) return;
		/** @type {Rect} */
		const f = first;
		const d = el("div", "dot " + p.status + (dense ? " dense" : ""));
		d.style.cssText = "left:" + (f.x + f.w / 2) + "px;top:" + (f.y + f.h / 2) + "px;color:" + c;
		d.title = p.agent + ": " + firstLine(p.task);
		d.appendChild(el("i"));
		if (!dense) d.appendChild(el("span", "", p.agent + (p.status === "holding" ? " ⏳" : "")));
		ov.appendChild(d);
	});
	Object.values(waiting).forEach(({ r, n }) => {
		const b = el("div", "badge", "⏳ " + n);
		b.title = n + " plan" + (n === 1 ? "" : "s") + " waiting here";
		b.style.cssText = "left:" + (r.x + r.w / 2) + "px;top:" + (r.y + Math.min(r.h - 8, r.h / 2 + 14)) + "px";
		ov.appendChild(b);
	});
	renderLegend(plans);
}

/** @param {Plan[]} plans */
function renderLegend(plans) {
	const lg = $("legend");
	lg.textContent = "";
	if (!plans.length) {
		lg.appendChild(el("div", "none", replay ? "No agents in flight at this point of the replay." : "No agents in flight. Start a swarm or sim to see activity."));
	}
	if (plans.length > DENSE) {
		const flying = plans.filter((p) => p.status === "cleared");
		lg.appendChild(el("div", "", flying.length + " in flight · " + (plans.length - flying.length) + " holding"));
		queues(plans).slice(0, 5).forEach((q) => { lg.appendChild(el("div", "item dim", "⏳ " + q.count + " on " + q.paths.join(", "))); });
		lg.appendChild(el("div", "item dim", "hover a dot for its agent"));
	}
	else plans.forEach((p) => {
		const r = el("div", "item " + p.status);
		r.appendChild(agentEl(p.agent));
		const t = el("span", "dim", " " + (p.status === "holding" ? "⏳ " : "") + firstLine(p.task));
		r.appendChild(t);
		lg.appendChild(r);
	});
	const n = Math.min(RECENT_LANDS, m.lands.length);
	if (n) lg.appendChild(el("div", "key", "green outline: " + (n === 1 ? "the last land" : "the last " + n + " lands")));
}

/** @param {string[]} paths @param {string} kind @param {string} label */
function flash(paths, kind, label) {
	if (VIEW !== "map") return;
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

function renderTimeline() {
	const t = $("trunk");
	/** @type {Record<string, HTMLElement>} */
	const shown = {};
	for (const n of /** @type {HTMLCollectionOf<HTMLElement>} */ (t.children)) if (n.dataset.sha) shown[n.dataset.sha] = n;
	if (!m.lands.length) { t.textContent = ""; t.appendChild(el("div", "none", "Nothing landed yet. Each land appears here as a commit on trunk.")); return; }
	t.querySelectorAll(".none").forEach((n) => { n.remove(); });
	/** @type {Record<string, boolean>} */
	const keep = {};
	m.lands.slice(-40).forEach((l) => {
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
		if (l.paths.length) c.dataset.path = l.paths[0];
		t.appendChild(c);
	});
	for (const n of Array.from(/** @type {HTMLCollectionOf<HTMLElement>} */ (t.children))) if (!keep[n.dataset.sha || ""]) n.remove();
	t.scrollLeft = t.scrollWidth;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 150); });

renderAll();
const stopLive = live(handle, (status) => {
	if (replay) return;
	if (status === "live") setConn("live", "live");
	else setConn("down", KEY ? "reconnecting…" : "no ?key= in URL");
});

// The live feed and /state come from the Tower alone, so they answer even for a trunk that was
// torn down; /tree reads trunk itself. A bad key or a missing trunk stops the page, saying which.
api("/tree").catch((err) => {
	if (!fatal(err)) return;
	stopLive();
	setConn("down", "unavailable");
	bar.after(failure(err, "note gone"));
});
