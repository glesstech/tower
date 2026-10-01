// The live dashboard: one self-contained page (no build step, no CDN) that subscribes to
// /repos/:repo/live and draws the trunk as a treemap, with each in-flight agent as a colored
// region over its claims, holding plans queued behind their blockers, drift flashing red on
// the offending paths, lands streaming into a trunk timeline, and the headline counters.
//
// The client script lives inside a template literal, so it uses no backticks or "${".

export function dashboardPage(repo: string): string {
	return HTML.replace("__REPO__", JSON.stringify(repo).replace(/</g, "\\u003c"));
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tower · live</title>
<style>
	:root { --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3; --dim: #8b949e; --red: #f85149; --green: #3fb950; }
	* { box-sizing: border-box; }
	html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
	body { display: grid; grid-template-rows: auto 1fr 132px; grid-template-columns: 1fr 340px; grid-template-areas: "head head" "map side" "time time"; gap: 10px; padding: 10px; }
	header { grid-area: head; display: flex; align-items: center; gap: 24px; }
	h1 { margin: 0; font-size: 18px; font-weight: 600; }
	h1 small { color: var(--dim); font-weight: 400; }
	#conn { font-size: 12px; color: var(--dim); }
	#conn::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--dim); }
	#conn.live::before { background: var(--green); box-shadow: 0 0 6px var(--green); }
	#conn.down::before { background: var(--red); }
	.counters { margin-left: auto; display: flex; gap: 12px; }
	.counter { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 14px; min-width: 150px; }
	.counter b { display: block; font-size: 28px; font-variant-numeric: tabular-nums; line-height: 1.1; }
	.counter span { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
	.counter.bump b { animation: bump .6s ease-out; }
	@keyframes bump { 0% { transform: scale(1.35); color: #fff; } 100% { transform: scale(1); } }
	#map { grid-area: map; position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
	#tree, #overlay { position: absolute; inset: 0; }
	#overlay { pointer-events: none; }
	.dir { position: absolute; border: 1px solid #2a3038; background: rgba(255,255,255,.015); overflow: hidden; }
	.dir > label { position: absolute; left: 4px; top: 1px; right: 4px; font-size: 10px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.file { position: absolute; background: #1f252d; border: 1px solid #0d1117; overflow: hidden; }
	.file > label { position: absolute; left: 3px; top: 1px; right: 2px; font-size: 9px; color: #6e7681; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.claim { position: absolute; border: 2px solid; border-radius: 3px; transition: all .4s ease; }
	.claim.holding { border-style: dashed; background: none !important; opacity: .8; }
	.dot { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 5px; transition: left .6s ease, top .6s ease; white-space: nowrap; }
	.dot i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #0d1117; box-shadow: 0 0 0 2px currentColor, 0 0 12px currentColor; background: currentColor; animation: pulse 1.6s ease-in-out infinite; }
	.dot.holding i { background: transparent; animation: none; box-shadow: 0 0 0 2px currentColor; }
	.dot span { font-size: 11px; font-weight: 600; background: rgba(13,17,23,.85); padding: 1px 6px; border-radius: 4px; }
	@keyframes pulse { 50% { transform: scale(1.25); } }
	.flash { position: absolute; z-index: 2; border-radius: 3px; animation: flash 2.4s ease-out forwards; }
	.flash.drift { background: rgba(248,81,73,.55); border: 2px solid var(--red); }
	.flash.land { background: rgba(63,185,80,.5); border: 2px solid var(--green); }
	.flash em { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font: 700 11px ui-sans-serif, system-ui; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px #000; }
	@keyframes flash { 0%, 30%, 60% { opacity: 1; } 15%, 45% { opacity: .3; } 100% { opacity: 0; } }
	#empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--dim); }
	aside { grid-area: side; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
	section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; overflow: auto; min-height: 0; }
	section h2 { margin: 0 0 6px; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
	#flying { flex: 2; } #holding { flex: 1.3; } #log { flex: 1; }
	.plan { border-left: 3px solid; padding: 3px 0 3px 8px; margin-bottom: 6px; }
	.plan b { font-size: 12px; }
	.plan div { color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.plan code, .entry code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
	.entry { font-size: 11px; color: var(--dim); padding: 2px 0; border-bottom: 1px solid #21262d; }
	.entry.drift b { color: var(--red); } .entry.land b { color: var(--green); }
	.none { color: #484f58; font-size: 11px; }
	#timeline { grid-area: time; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; min-width: 0; }
	#timeline h2 { margin: 0 0 6px; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
	#trunk { position: relative; flex: 1; display: flex; align-items: center; gap: 10px; overflow-x: auto; padding: 0 6px; }
	#trunk::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 2px; background: var(--line); min-width: 100%; }
	.commit { position: relative; flex: 0 0 auto; width: 190px; background: #0d1117; border: 1px solid var(--line); border-top: 3px solid; border-radius: 6px; padding: 4px 8px; animation: slide .6s ease-out; }
	.commit b { font-size: 12px; } .commit code { font: 10px ui-monospace, Menlo, monospace; color: var(--dim); float: right; }
	.commit div { font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	@keyframes slide { from { transform: translateX(60px); opacity: 0; } to { transform: none; opacity: 1; } }
</style>
</head>
<body>
<header>
	<h1>tower <small id="repo"></small></h1>
	<span id="conn">connecting</span>
	<div class="counters">
		<div class="counter" id="c-conflicts_prevented"><b>0</b><span>conflicts prevented</span></div>
		<div class="counter" id="c-drift_blocked"><b>0</b><span>drift blocked</span></div>
		<div class="counter" id="c-landed"><b>0</b><span>landed</span></div>
	</div>
</header>
<div id="map"><div id="tree"></div><div id="overlay"></div><div id="empty">waiting for trunk…</div></div>
<aside>
	<section id="flying"><h2>In flight</h2><div></div></section>
	<section id="holding"><h2>Holding</h2><div></div></section>
	<section id="log"><h2>Events</h2><div></div></section>
</aside>
<div id="timeline"><h2>Trunk</h2><div id="trunk"></div></div>
<script>
(function () {
	"use strict";
	var REPO = __REPO__;
	var KEY = new URLSearchParams(location.search).get("key") || "";
	var BASE = location.origin + "/repos/" + encodeURIComponent(REPO);
	var STATS = ["conflicts_prevented", "drift_blocked", "landed"];

	var plans = {};       // every plan seen this session, by id (landed/released kept for names)
	var lands = [];       // oldest first
	var stats = {};
	var treePaths = [];   // files on trunk HEAD
	var extra = {};       // paths seen in claims, lands and drift but not (yet) on trunk
	var rects = {};       // node path ("src/", "src/a.ts") -> {x, y, w, h}

	var $ = function (id) { return document.getElementById(id); };
	$("repo").textContent = REPO;

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function color(agent) {
		var h = 0;
		for (var i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
		return "hsl(" + (h % 360) + ", 80%, 62%)";
	}

	function agentOf(planId) { return plans[planId] ? plans[planId].agent : planId; }
	function active(p) { return p.status === "cleared" || p.status === "holding"; }

	// ── live feed ──────────────────────────────────────────────────────────────

	var backoff = 1000;
	function connect() {
		var ws = new WebSocket(BASE.replace(/^http/, "ws") + "/live?key=" + encodeURIComponent(KEY));
		ws.onopen = function () { backoff = 1000; setConn("live", "live"); };
		ws.onmessage = function (e) { handle(JSON.parse(e.data)); };
		ws.onclose = function () {
			setConn("down", KEY ? "reconnecting…" : "no ?key= in URL");
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 15000);
		};
	}
	function setConn(cls, text) { $("conn").className = cls; $("conn").textContent = text; }

	function handle(ev) {
		if (ev.type === "state") {
			plans = {};
			ev.state.plans.forEach(function (p) { plans[p.id] = p; });
			lands = ev.state.lands.slice().reverse().map(function (l) {
				return { sha: l.sha, planId: l.plan_id, agent: l.agent, summary: l.summary, paths: l.paths || [], at: l.landed_at };
			});
			stats = Object.assign({}, ev.state.stats);
			renderCounters();
			renderTimeline();
			loadTree();
		} else if (ev.type === "plan") {
			plans[ev.plan.id] = ev.plan;
			if (ev.plan.status === "holding" && ev.plan.blockedBy.length) logEntry("", ev.plan.agent + " holding behind " + ev.plan.blockedBy.map(agentOf).join(", "));
			else if (ev.plan.status === "cleared" && !ev.plan.fork) logEntry("", ev.plan.agent + " cleared");
			else if (ev.plan.status === "released") logEntry("", ev.plan.agent + " released");
			if (addPaths(ev.plan.claims.map(function (c) { return c.path; }))) layout();
			else renderOverlay();
		} else if (ev.type === "drift") {
			logEntry("drift", agentOf(ev.planId) + " drifted: ", ev.paths);
			if (addPaths(ev.paths)) layout();
			flash(ev.paths, "drift", "DRIFT " + agentOf(ev.planId));
		} else if (ev.type === "land") {
			var p = plans[ev.planId] || {};
			lands.push({ sha: ev.sha, planId: ev.planId, agent: ev.agent || p.agent || ev.planId, summary: ev.summary || p.task || "", paths: ev.paths, at: ev.at });
			logEntry("land", agentOf(ev.planId) + " landed ", [ev.sha.slice(0, 7)]);
			renderTimeline();
			if (addPaths(ev.paths)) layout();
			flash(ev.paths, "land", "LANDED " + agentOf(ev.planId));
			loadTreeSoon();
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

	var treeTimer = null;
	function loadTreeSoon() { clearTimeout(treeTimer); treeTimer = setTimeout(loadTree, 1500); }
	function loadTree() {
		fetch(BASE + "/tree", { headers: { Authorization: "Bearer " + KEY } })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (t) {
				if (t) treePaths = t.paths;
				lands.forEach(function (l) { addPaths(l.paths); });
				Object.keys(plans).forEach(function (id) { addPaths(plans[id].claims.map(function (c) { return c.path; })); });
				layout();
			})
			.catch(function () { layout(); });
	}

	// Returns true when a path is new to the map, so the caller re-lays it out.
	function addPaths(paths) {
		var known = {};
		treePaths.forEach(function (p) { known[p] = true; });
		var added = false;
		paths.forEach(function (p) {
			if (known[p] || extra[p] || rects[p]) return;
			extra[p] = true;
			added = true;
		});
		return added;
	}

	function buildTree() {
		var root = { name: REPO, path: "", dir: true, children: {}, size: 0 };
		treePaths.concat(Object.keys(extra)).forEach(function (p) {
			var parts = p.split("/");
			var isDir = p.charAt(p.length - 1) === "/";
			if (isDir) parts.pop();
			var node = root;
			for (var i = 0; i < parts.length; i++) {
				var last = i === parts.length - 1;
				var dir = !last || isDir;
				var path = parts.slice(0, i + 1).join("/") + (dir ? "/" : "");
				if (!node.children[parts[i] + (dir ? "/" : "")]) node.children[parts[i] + (dir ? "/" : "")] = { name: parts[i], path: path, dir: dir, children: {}, size: 0 };
				node = node.children[parts[i] + (dir ? "/" : "")];
			}
		});
		(function size(n) {
			var kids = Object.keys(n.children).map(function (k) { return n.children[k]; });
			n.size = n.dir ? Math.max(1, kids.reduce(function (s, k) { return s + size(k); }, 0)) : 1;
			n.list = kids;
			return n.size;
		})(root);
		return root;
	}

	// Squarified treemap (Bruls, Huizing, van Wijk).
	function squarify(items, x, y, w, h, out) {
		var total = items.reduce(function (s, it) { return s + it.size; }, 0);
		if (!total || w <= 0 || h <= 0) return;
		var scale = (w * h) / total;
		var rest = items.slice().sort(function (a, b) { return b.size - a.size; }).map(function (it) { return { item: it, area: it.size * scale }; });
		var row = [];
		function worst(r, side) {
			var s = 0, max = 0, min = Infinity;
			r.forEach(function (c) { s += c.area; max = Math.max(max, c.area); min = Math.min(min, c.area); });
			return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
		}
		function place(r) {
			var s = r.reduce(function (a, c) { return a + c.area; }, 0);
			if (w >= h) {
				var cw = s / h, cy = y;
				r.forEach(function (c) { var ch = c.area / cw; out.push({ item: c.item, x: x, y: cy, w: cw, h: ch }); cy += ch; });
				x += cw; w -= cw;
			} else {
				var rh = s / w, cx = x;
				r.forEach(function (c) { var cw2 = c.area / rh; out.push({ item: c.item, x: cx, y: y, w: cw2, h: rh }); cx += cw2; });
				y += rh; h -= rh;
			}
		}
		while (rest.length) {
			var side = Math.min(w, h);
			if (!row.length || worst(row.concat([rest[0]]), side) <= worst(row, side)) row.push(rest.shift());
			else { place(row); row = []; }
		}
		if (row.length) place(row);
	}

	function layout() {
		var box = $("tree");
		box.textContent = "";
		rects = {};
		var root = buildTree();
		$("empty").style.display = root.list.length ? "none" : "flex";
		var W = box.clientWidth, H = box.clientHeight;
		rects[""] = { x: 0, y: 0, w: W, h: H };
		(function draw(n, x, y, w, h) {
			var out = [];
			squarify(n.list, x, y, w, h, out);
			out.forEach(function (r) {
				rects[r.item.path] = { x: r.x, y: r.y, w: r.w, h: r.h };
				var e = el("div", r.item.dir ? "dir" : "file");
				e.style.cssText = "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px";
				e.title = r.item.path;
				if (r.w > 28 && r.h > 12) e.appendChild(el("label", "", r.item.name + (r.item.dir ? "/" : "")));
				box.appendChild(e);
				if (r.item.dir) {
					var head = r.h > 30 && r.w > 30 ? 14 : 2;
					if (r.w > 6 && r.h > head + 4) draw(r.item, r.x + 2, r.y + head, r.w - 4, r.h - head - 2);
				}
			});
		})(root, 0, 0, W, H);
		renderOverlay();
	}

	// The rect for a path, or its nearest ancestor on the map.
	function rectFor(path) {
		var p = path;
		while (true) {
			if (rects[p]) return rects[p];
			if (p.charAt(p.length - 1) !== "/" && rects[p + "/"]) return rects[p + "/"];
			if (!p) return null;
			var trimmed = p.replace(/\\/$/, "");
			var i = trimmed.lastIndexOf("/");
			p = i < 0 ? "" : trimmed.slice(0, i + 1);
		}
	}

	function renderOverlay() {
		var ov = $("overlay");
		Array.prototype.slice.call(ov.querySelectorAll(".claim, .dot")).forEach(function (e) { e.remove(); });
		Object.keys(plans).map(function (id) { return plans[id]; }).filter(active).forEach(function (p) {
			var c = color(p.agent);
			var first = null;
			p.claims.forEach(function (claim) {
				var r = rectFor(claim.path);
				if (!r) return;
				if (!first) first = r;
				var e = el("div", "claim " + p.status);
				e.style.cssText = "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px;border-color:" + c + ";background:" + c.replace("hsl", "hsla").replace(")", ", .22)");
				ov.appendChild(e);
			});
			if (!first) return;
			var d = el("div", "dot " + p.status);
			d.style.cssText = "left:" + (first.x + first.w / 2) + "px;top:" + (first.y + first.h / 2) + "px;color:" + c;
			d.appendChild(el("i"));
			d.appendChild(el("span", "", p.agent + (p.status === "holding" ? " ⏳" : "")));
			ov.appendChild(d);
		});
	}

	function flash(paths, kind, label) {
		var ov = $("overlay");
		var seen = {};
		paths.forEach(function (path, i) {
			var r = rectFor(path);
			if (!r) return;
			var k = r.x + "," + r.y;
			if (seen[k]) return;
			seen[k] = true;
			var e = el("div", "flash " + kind);
			e.style.cssText = "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px";
			if (i === 0 && r.w > 60 && r.h > 14) e.appendChild(el("em", "", label));
			ov.appendChild(e);
			setTimeout(function () { e.remove(); }, 2500);
		});
	}

	// ── panels ────────────────────────────────────────────────────────────────

	function overlaps(a, b) {
		if (a.path === b.path) return true;
		if (a.dir && b.path.indexOf(a.path) === 0) return true;
		if (b.dir && a.path.indexOf(b.path) === 0) return true;
		return false;
	}

	// A holding plan's blockedBy can go stale (only newly cleared plans are rebroadcast),
	// so blockers are recomputed from the plans active right now, as the Tower does.
	function blockers(p, all) {
		return all.filter(function (q) {
			return q.id !== p.id && (q.status === "cleared" || q.createdAt < p.createdAt) &&
				q.claims.some(function (a) { return p.claims.some(function (b) { return overlaps(a, b); }); });
		});
	}

	function renderPlans() {
		var all = Object.keys(plans).map(function (id) { return plans[id]; }).filter(active)
			.sort(function (a, b) { return a.createdAt - b.createdAt; });
		var flying = $("flying").lastChild, holding = $("holding").lastChild;
		flying.textContent = ""; holding.textContent = "";
		all.forEach(function (p) {
			var row = el("div", "plan");
			row.style.borderColor = color(p.agent);
			row.appendChild(el("b", "", p.agent));
			row.appendChild(el("div", "", p.task));
			var claims = el("div");
			claims.appendChild(el("code", "", p.claims.map(function (c) { return c.path; }).join("  ")));
			row.appendChild(claims);
			if (p.status === "holding") {
				var names = blockers(p, all).map(function (q) { return q.agent; });
				row.appendChild(el("div", "", "⏳ waiting on " + (names.join(", ") || "clearance")));
				holding.appendChild(row);
			} else flying.appendChild(row);
		});
		if (!flying.childNodes.length) flying.appendChild(el("div", "none", "no agents in flight"));
		if (!holding.childNodes.length) holding.appendChild(el("div", "none", "nobody waiting"));
	}

	function logEntry(kind, text, paths) {
		var box = $("log").lastChild;
		var e = el("div", "entry " + kind);
		e.appendChild(el("b", "", text));
		if (paths) e.appendChild(el("code", "", paths.join(", ")));
		box.insertBefore(e, box.firstChild);
		while (box.childNodes.length > 60) box.removeChild(box.lastChild);
	}

	function renderCounters(bumped) {
		STATS.forEach(function (k) {
			var c = $("c-" + k);
			c.firstChild.textContent = String(stats[k] || 0);
			if (k === bumped) { c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); }
		});
	}

	function renderTimeline() {
		var t = $("trunk");
		var shown = {};
		Array.prototype.forEach.call(t.childNodes, function (n) { shown[n.dataset.sha] = n; });
		if (!lands.length) { t.textContent = ""; t.appendChild(el("div", "none", "nothing landed yet")); return; }
		Array.prototype.slice.call(t.querySelectorAll(".none")).forEach(function (n) { n.remove(); });
		var keep = {};
		lands.slice(-40).forEach(function (l) {
			keep[l.sha] = true;
			if (shown[l.sha]) return;
			var c = el("div", "commit");
			c.dataset.sha = l.sha;
			c.style.borderTopColor = color(l.agent);
			c.appendChild(el("code", "", l.sha.slice(0, 7)));
			c.appendChild(el("b", "", l.agent));
			c.appendChild(el("div", "", l.summary));
			c.appendChild(el("div", "", l.paths.length + " file" + (l.paths.length === 1 ? "" : "s") + " · " + new Date(l.at).toLocaleTimeString()));
			c.title = l.paths.join("\\n");
			t.appendChild(c);
		});
		Array.prototype.slice.call(t.childNodes).forEach(function (n) { if (!keep[n.dataset.sha]) n.remove(); });
		t.scrollLeft = t.scrollWidth;
	}

	var resizeTimer = null;
	window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 150); });

	renderCounters(); renderPlans(); renderTimeline();
	connect();
})();
</script>
</body>
</html>
`;
