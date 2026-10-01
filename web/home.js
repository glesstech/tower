// @ts-check
// The home page at /: what tower is, how to connect an agent, and the trunks from GET /repos
// (every trunk with the operator ?key=, otherwise only the public demo trunk, which needs
// no key to watch). Each trunk links to its Live, Plans and Code pages.

import { $, KEY, el, nav, withKey } from "./client.js";

/** Set to the demo video's URL to link it from the page. */
const VIDEO = "";

/**
 * @typedef {{ in_flight: number, holding: number, landed: number, conflicts_prevented: number }} Counts
 * @typedef {{ repo: string, counts: Counts | null }} Trunk
 */

nav();
snippet(null);
if (VIDEO) link($("links"), "Watch the video", VIDEO);
load().catch((err) => console.error(err));

async function load() {
	const res = await fetch("/repos", { headers: KEY ? { Authorization: "Bearer " + KEY } : {} });
	if (!res.ok) throw new Error("/repos: " + res.status);
	/** @type {{ demo: string | null, trunks: Trunk[] }} */
	const { demo, trunks } = await res.json();
	if (demo) {
		link($("links"), "Watch the live demo", withKey(page(demo, "dashboard"))).classList.add("demo");
		snippet(demo);
	}
	if (trunks.length) table(trunks);
}

/** @param {Trunk[]} trunks */
function table(trunks) {
	const body = /** @type {HTMLElement} */ ($("trunks").querySelector("tbody"));
	for (const { repo, counts } of trunks) {
		const tr = el("tr");
		tr.appendChild(el("td", "", repo));
		for (const k of /** @type {const} */ (["in_flight", "holding", "landed", "conflicts_prevented"])) {
			tr.appendChild(el("td", "n", counts ? String(counts[k]) : "–"));
		}
		const go = el("td", "go");
		for (const [label, name] of [["Live", "dashboard"], ["Plans", "plans"], ["Code", "code"]]) {
			link(go, label, withKey(page(repo, name))).classList.add("button");
		}
		tr.appendChild(go);
		body.appendChild(tr);
	}
	$("trunks").hidden = false;
}

/** The `claude mcp add` command for this deployment. @param {string | null} repo */
function snippet(repo) {
	$("snippet").textContent =
		"claude mcp add --transport http tower " + location.origin + "/repos/" + (repo ? encodeURIComponent(repo) : "<repo>") + "/mcp \\\n" +
		'  --header "Authorization: Bearer $TOWER_API_KEY"';
}

/** @param {string} repo @param {string} name */
function page(repo, name) {
	return "/repos/" + encodeURIComponent(repo) + "/" + name;
}

/** @param {HTMLElement} parent @param {string} label @param {string} href */
function link(parent, label, href) {
	const a = el("a", "", label);
	a.href = href;
	parent.appendChild(a);
	return a;
}
