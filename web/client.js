// @ts-check
// Shared client for every page in web/: the repo and key from the page's own URL, the API
// and live feed with that key, the top nav, and small DOM helpers. Plain ES module, no build
// step; `npm run typecheck` checks it through the JSDoc types.
//
// Pages are served without a key from /repos/:repo/<page> and call the API with the ?key=
// from their URL, so the read-only dashboard key keeps working. The nav carries ?key= along.

/** The repo from /repos/:repo/..., or "" on pages outside a repo. */
export const REPO = decodeURIComponent((location.pathname.match(/^\/repos\/([^/]+)/) || ["", ""])[1]);
export const KEY = new URLSearchParams(location.search).get("key") || "";
export const BASE = location.origin + "/repos/" + encodeURIComponent(REPO);

/**
 * Top nav entries. To add a page, add web/<page>.html and an entry here; it is served at
 * /repos/:repo/<page> (or at its own path for pages outside a repo).
 * @type {{ label: string, path: (repo: string) => string | null }[]}
 */
export const NAV = [
	{ label: "Trunks", path: () => "/" },
	{ label: "Live", path: (repo) => (repo ? "/repos/" + encodeURIComponent(repo) + "/dashboard" : null) },
	{ label: "Plans", path: (repo) => (repo ? "/repos/" + encodeURIComponent(repo) + "/plans" : null) },
	{ label: "Code", path: (repo) => (repo ? "/repos/" + encodeURIComponent(repo) + "/code" : null) },
	{ label: "Inbox", path: (repo) => (repo ? "/repos/" + encodeURIComponent(repo) + "/inbox" : null) },
];

/** A link to another page that keeps this page's ?key=. */
export function withKey(/** @type {string} */ path) {
	return KEY ? path + (path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY) : path;
}

/** Puts the top nav at the start of <body>, marking the current page. */
export function nav() {
	const bar = el("nav", "topnav");
	bar.appendChild(el("b", "brand", "tower"));
	if (REPO) bar.appendChild(el("span", "repo", REPO));
	for (const entry of NAV) {
		const path = entry.path(REPO);
		if (path == null) continue;
		const a = el("a", path === location.pathname ? "active" : "", entry.label);
		a.href = withKey(path);
		bar.appendChild(a);
	}
	document.body.insertBefore(bar, document.body.firstChild);
	return bar;
}

/**
 * GET (or other method) a /repos/:repo API route with the page's key. Resolves to the JSON
 * body; rejects on a non-2xx response.
 * @param {string} path e.g. "/tree"
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
export async function api(path, init = {}) {
	const headers = new Headers(init.headers);
	headers.set("Authorization", "Bearer " + KEY);
	const res = await fetch(BASE + path, { ...init, headers });
	if (!res.ok) throw new Error(path + ": " + res.status);
	return res.json();
}

/**
 * Subscribes to /repos/:repo/live, reconnecting with backoff. The first connect gets a
 * `state` snapshot; a reconnect passes ?since= the last seq seen, so it gets the events it
 * missed instead (or a fresh snapshot if they are gone). `onStatus` hears "live" on connect
 * and "down" on each drop. Returns a function that closes the feed for good.
 * @param {(event: any) => void} onEvent
 * @param {(status: "live" | "down") => void} [onStatus]
 */
export function live(onEvent, onStatus) {
	let backoff = 1000;
	let stopped = false;
	/** @type {WebSocket | null} */
	let ws = null;
	/** @type {number | null} */
	let seq = null;
	function connect() {
		const since = seq === null ? "" : "&since=" + seq;
		ws = new WebSocket(BASE.replace(/^http/, "ws") + "/live?key=" + encodeURIComponent(KEY) + since);
		ws.onopen = () => { backoff = 1000; onStatus?.("live"); };
		ws.onmessage = (e) => {
			const ev = JSON.parse(e.data);
			if (ev.type === "state") seq = ev.state.seq ?? null;
			else if (ev.type === "reset") seq = null;
			else if (typeof ev.seq === "number") seq = ev.seq;
			onEvent(ev);
		};
		ws.onclose = () => {
			if (stopped) return;
			onStatus?.("down");
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 15000);
		};
	}
	connect();
	return () => { stopped = true; ws?.close(); };
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [cls]
 * @param {string | null} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}

/** The element with this id; throws if the page lacks it. */
export function $(/** @type {string} */ id) {
	const e = document.getElementById(id);
	if (!e) throw new Error("#" + id + " missing");
	return e;
}

/** A stable color per agent name. */
export function color(/** @type {string} */ agent) {
	let h = 0;
	for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
	return "hsl(" + (h % 360) + ", 80%, 62%)";
}

/** "just now", "5m ago", "3h ago", "2d ago" for a timestamp in ms. */
export function ago(/** @type {number} */ at, now = Date.now()) {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 10) return "just now";
	if (s < 60) return s + "s ago";
	if (s < 3600) return Math.floor(s / 60) + "m ago";
	if (s < 86400) return Math.floor(s / 3600) + "h ago";
	return Math.floor(s / 86400) + "d ago";
}
