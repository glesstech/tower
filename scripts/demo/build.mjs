#!/usr/bin/env node
// Builds the demo video (#51) from saved sim runs and the kept demo trunks on tower-dev.
//
// Each scene has narration, a minimum length and a recording. The narration is read from
// scripts/demo/voice/<scene>.{m4a,wav,mp3,aiff} when a recorded take exists, else spoken by
// Kokoro, a local neural TTS model (scripts/demo/tts.py, run through uv; VOICE picks the voice).
// TTS=say uses macOS `say` instead. A scene lasts as long as its narration (plus a breath) or its
// minimum, whichever is longer; replays are sped up or slowed down to fill it. Captions are the
// narration, split into sentences and timed by length. Scenes join into scripts/demo/out/tower-demo.mp4.
//
//   (set -a; . ./.dev.vars; npm run demo)             # every scene
//   (set -a; . ./.dev.vars; npm run demo -- review)   # rerecord some scenes, then rejoin
//
// Inputs (see scripts/demo/runs/): plain-live.{txt,json} from `sim --plain`, tower.json from the
// paired `sim --seed --keep` run on demo-contrast, llm.json from the --llm run on demo-llm,
// drift.json, broad.txt (a 422 claim_too_broad response), and the demo-review5 trunk with its
// three changes still waiting in the inbox. The review scene approves one, so rerun
// `sim --repo demo-review5 --seed --keep --agents 10 --modules 3 --stagger 20 --review 3` before
// rerecording it.

import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { record } from "./record.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "runs");
const OUT = join(HERE, "out");
const VOICE = join(HERE, "voice");
const BASE = process.env.TOWER_URL;
const KEY = process.env.TOWER_API_KEY;
if (!BASE || !KEY) throw new Error("set TOWER_URL and TOWER_API_KEY (from .dev.vars)");
const TTS = process.env.TTS ?? "kokoro";
const TTS_VOICE = process.env.VOICE ?? (TTS === "say" ? "Samantha" : "af_heart");

const json = async (name) => JSON.parse(await readFile(join(RUNS, name), "utf8"));
const plain = (await json("plain-live.json")).report;
const tower = (await json("tower.json")).report;
const review = (await json("review.json")).report;
const llmPlan = (await json("llm.json")).events.find((e) => e.agent?.startsWith("claude-"))?.planId;
const page = (repo, path, q = "") => `${BASE}/repos/${repo}/${path}?key=${KEY}${q}`;
const local = (file) => pathToFileURL(join(HERE, file)).href;

/** Replay speed that plays `events` back in about `seconds`, using the dashboard's own delays. */
function speedFor(events, seconds) {
	const total = (speed) => events.reduce((sum, e, i) => sum + (i === 0 ? 0 : Math.max(20, Math.min(2000, Math.max(0, e.at - events[i - 1].at)) / speed)), 0);
	let lo = 0.05, hi = 512;
	for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; total(mid) > seconds * 1000 ? (lo = mid) : (hi = mid); }
	return hi;
}

/** Loads a saved run into the dashboard and replays it over `seconds`. */
function replay(file, seconds) {
	return async (/** @type {import("playwright-core").Page} */ p) => {
		const { events } = await json(file);
		const speed = speedFor(events, seconds);
		await p.waitForTimeout(500);
		await p.evaluate((s) => {
			const sel = /** @type {HTMLSelectElement} */ (document.getElementById("r-speed"));
			const opt = new Option(`${Math.round(s * 10) / 10}×`, String(s), true, true);
			sel.add(opt);
			sel.value = String(s);
		}, speed);
		await p.setInputFiles("#r-load", join(RUNS, file));
	};
}

/** Types `lines` into the terminal page over `seconds`. */
const terminal = (lines, seconds, title) => async (p) => { p.evaluate((a) => window.play(a), { lines, seconds, title }); };
/** Shows a title or numbers card. */
const card = (opts) => async (p) => { p.evaluate((a) => window.show(a), opts); };

/** The plain-git terminal: the command, a sample of what the agents printed, then the totals. */
async function plainLines() {
	const log = (await readFile(join(RUNS, "plain-live.txt"), "utf8")).split("\n");
	const agentLines = log.filter((l) => /^\d\d:\d\d:\d\d/.test(l) && /CONFLICT|pushed|rejected/.test(l));
	const sample = agentLines.filter((_, i) => i % Math.max(1, Math.floor(agentLines.length / 26)) === 0).slice(0, 26)
		.map((l) => (l.includes("CONFLICT") ? "!" : "") + l.replace(/^(\d\d:\d\d:\d\d)\.\d+/, "$1"));
	return [
		"$ node sim/agents.mjs --plain --agents 30 --modules 4 --stagger 30 --think 20",
		...sample,
		"",
		"plain git (no tower)",
		`  agents            ${plain.agents}`,
		`  pushed            ${plain.pushed}`,
		`  rejectedPushes    ${plain.rejectedPushes}`,
		`!  mergeConflicts    ${plain.mergeConflicts}`,
		`!  edits made        ${plain.agents + plain.mergeConflicts} for ${plain.agents} changes`,
	];
}

async function broadLines() {
	const [body] = (await readFile(join(RUNS, "broad.txt"), "utf8")).split("\n");
	const res = JSON.parse(body);
	return [
		`$ curl -X POST $TOWER/repos/demo-broad/plans -d '{"agent":"greedy-agent","task":"refactor the modules","claims":["src/"]}'`,
		"!HTTP 422  claim_too_broad",
		`  ${res.broad[0].reason}`,
		"",
		"# Claim the files you will change instead, e.g.",
		...res.suggested.slice(0, 5).map((s) => `  ${s}`),
	];
}

const edits = plain.agents + plain.mergeConflicts;
const SCENES = [
	{
		id: "01-hook", min: 22, url: local("card.html"),
		act: card({ kicker: "tower", title: "Many coding agents. One repository.", sub: "A coordination layer for agents that share a Git repo, built on Cloudflare Workers, Durable Objects and Artifacts." }),
		say: "Coding agents are fast, and they keep getting cheaper. So the next step is obvious: put thirty of them on one repository at the same time. The trouble is that Git was built for a handful of humans who merge a few times a day. Put thirty agents on one repo, and they spend their time fighting each other. This is tower: a coordination layer for coding agents that share a Git repository, built on Cloudflare.",
	},
	{
		id: "02-plain-git", min: 50, url: local("terminal.html"),
		// The totals arrive with "By the end", about four fifths of the way through the narration.
		act: async (p, s, spoken) => terminal(await plainLines(), spoken * 0.8, "plain git: 30 agents, no coordination")(p),
		say: `First, the baseline. Here are thirty scripted agents with no coordination, working on a small app with four modules. Each one does what an agent normally does: clone, spend some time on its edit, commit, and push. When a push is rejected, it pulls and rebases. When the rebase conflicts, the edit is thrown away and done again on the new trunk. Real agents take minutes on an edit, so here every agent spends about twenty seconds on its change, and their pushes overlap the way real agents' would. Watch the conflicts go by. Each orange line is an agent whose finished edit no longer applies. By the end: ${plain.mergeConflicts} merge conflicts. Thirty changes took ${edits} edits, because every conflict is work done twice. Git found every one of those conflicts at merge time, after the work was already done.`,
	},
	{
		id: "03-tower", min: 80, url: page("demo-contrast", "dashboard", "&view=map"),
		setup: (p, s) => replay("tower.json", s - 2)(p),
		say: `Now the same thirty agents doing the same work, through tower. Before an agent touches code, it files a flight plan: its task, and the files it will change. Nothing has been written yet, so tower can still say no for free. Tower clears a plan only when nobody else holds those files, and queues the rest, first in, first out. Each cleared agent gets its own Artifacts fork, with a write token scoped to that fork, so no agent ever holds trunk credentials. On the map, each dot is an agent, over the part of the code it claimed. Sixteen of the thirty agents picked the same hot module, m zero, so they wait in line there, while agents on the other modules land in parallel. The strip at the top shows lands per minute, the queue in front of the hot file, and agents in flight. When an agent lands, tower diffs its fork against where it started, checks that the change stayed inside its claim, commits it onto trunk itself, deletes the fork, and clears the next plan in line. Agents never push to trunk, so trunk never sees a merge. Tower took a little longer on the clock here, because the agents on the hot file took turns. What it saves is the redone work. ${tower.conflictsPrevented} conflicts prevented. Zero conflicts on trunk. Thirty edits for thirty changes, and no work redone.`,
	},
	{
		id: "04-real-agent", min: 55, url: page("demo-llm", `plans/${llmPlan}`),
		act: async (p) => {
			await p.waitForTimeout(16000);
			await p.mouse.move(900, 300);
			await p.mouse.wheel(0, 400);
		},
		say: "Those were scripted agents. This one is Claude Code, talking to tower over MCP. Its prompt is one short paragraph and the task. The tower MCP server's own instructions teach it the rest of the protocol. It asked tower which files fit the task, and why those files look the way they do, claimed exactly one file, got its own fork, made the change, and checked it. Then it landed, with evidence attached: what it was asked, what it planned, and what it ran to check its work. The plan page does the job of a pull request: the task, the lifecycle, the diff, and the risk score. Up top, the lifecycle shows how long it spent in each state: filed, cleared, forked, landed. Its land scored a risk of three out of a hundred, so it went straight in, with no human needed. Real agents and scripted agents share the same trunk, and the same queue, and any agent that speaks MCP can join them.",
	},
	{
		id: "05-drift", min: 30, url: page("demo-drift", "dashboard"),
		setup: (p, s) => replay("drift.json", s - 2)(p),
		say: "Tower also holds agents to their word. When an agent asks to land, tower diffs its fork against the commit it started from. Change a file outside your claim, and the land is refused. In this run, two agents edited a README they never claimed. Tower blocked both lands. They reverted the stray edit, and landed cleanly. Tower needs no webhook per fork for this: it reads the two trees directly from Artifacts, and only descends into folders whose hash changed. The counter at the top shows both blocked lands.",
	},
	{
		id: "05b-broad-claim", min: 22, url: local("terminal.html"),
		act: async (p, s, spoken) => terminal(await broadLines(), spoken * 0.6, "tower API")(p),
		say: "Claims have to be honest in the other direction, too. An agent that claims all of source makes everyone else wait. So tower measures every claim against trunk, refuses one that is too broad, and suggests the specific files that fit the task instead, ranked by name and by what similar tasks changed before. An agent can still force a broad claim, but the dashboard counts every one.",
	},
	{
		id: "06-review", min: 50, url: page("demo-review5", "inbox"),
		act: async (p, s, spoken) => {
			await p.waitForTimeout(spoken * 640);
			for (const k of ["j", "k", "j", "j"]) { await p.keyboard.press(k); await p.waitForTimeout(900); }
			await p.keyboard.press("a");
		},
		say: `Not every change needs a human. And with hundreds of agents, no human can review every change. So tower scores each land for risk: its blast radius, its size, and its test evidence. Low-risk changes go straight to trunk. Anything that touches auth, CI config, migrations or secrets, or any change whose checks failed, waits in an inbox, grouped, riskiest first. Here, ${review.landed} changes landed on their own, and ${review.review} needed a human. Each card says why it's here: a sensitive auth path, a CI workflow, or checks that reported a failure. A reviewer moves with j and k, approves with a, or rejects, or sends a change back with a note for its agent. Decisions apply to a whole group at once. Approve one, and tower lands it, the same way it lands everything else.`,
	},
	{
		id: "07-intent-blame", min: 30, url: page("demo-llm", "code", "&path=src/modules/m0.ts"),
		act: async (p) => {
			await p.waitForTimeout(9000);
			await p.evaluate(() => {
				const hit = [...document.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent?.trim() === "claude-task-1");
				const card = hit?.closest("div[style], li, article, .land, div");
				const box = /** @type {HTMLElement | null} */ (card?.parentElement ?? null);
				if (box) { box.scrollIntoView({ block: "center", behavior: "smooth" }); box.style.outline = "2px solid #f6821f"; box.style.borderRadius = "6px"; }
			});
		},
		say: "And every file on trunk remembers why it changed. The code explorer shows trunk as it is now, and for each file, every land that touched it: the agent, the plan, the task, and the evidence. It is blame for intent, not just for lines. Here is the function Claude wrote, linked straight back to its plan. When an agent picks up a file next week, it can ask tower why the file looks the way it does, and get the same answer.",
	},
	{
		id: "09-scale", min: 40, url: local("card.html"),
		act: card({
			kicker: "scale", title: "250 agents. One trunk. Zero conflicts.", gap: 2600,
			stats: [["250", "agents on one trunk"], ["246", "plans active at once"], ["206", "conflicts prevented"], ["0", "conflicts on trunk"]],
		}),
		say: "How far does this go? We ran two hundred and fifty agents on one trunk. Up to two hundred and forty-six plans were active at once. The hottest module drew fifty-one agents on its own. Two hundred and six conflicts were prevented, every agent landed, and trunk ended with exactly one commit per land, and zero conflicts. The honest limit: agents that need the same file wait in line. That is the price of never redoing work. Symbol-level claims, so agents can share a file by claiming functions instead, are next. And because trunk is an ordinary Git repository in Artifacts, anything that speaks Git can still clone it.",
	},
	{
		id: "10-close", min: 22, url: local("card.html"),
		act: card({ kicker: "tower", title: "Built on Cloudflare.", sub: "Workers route every request. One Durable Object per trunk holds the queue and leases in SQLite. Every repo and fork lives in Artifacts.  github.com/glesstech/tower" }),
		say: "Tower runs entirely on Cloudflare. A Worker routes every request. One Durable Object per trunk holds the queue and the leases in SQLite. And every repository and fork lives in Cloudflare Artifacts. Agents speak plain Git and MCP, and nothing else. The code is on GitHub. Thanks for watching.",
	},
];

const exists = (f) => access(f).then(() => true, () => false);
const duration = async (f) => Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout);

/** The scene's narration track: George's take if there is one, else synthesized. */
async function voice(scene) {
	for (const ext of ["m4a", "wav", "mp3", "aiff"]) {
		const f = join(VOICE, `${scene.id}.${ext}`);
		if (await exists(f)) return f;
	}
	if (TTS === "say") {
		const f = join(OUT, `${scene.id}.say.aiff`);
		await run("say", ["-v", TTS_VOICE, "-r", "172", "-o", f, scene.say]);
		return f;
	}
	const f = join(OUT, `${scene.id}.tts.wav`);
	await run("uv", ["run", "-q", "--python", "3.12", "--with", "kokoro", "--with", "soundfile", "--with", "pip",
		"python", join(HERE, "tts.py"), TTS_VOICE, f, scene.say], { maxBuffer: 1 << 24 });
	return f;
}

/** Splits narration into caption chunks, timed by their share of the characters. */
function captionsFor(text, seconds, lead) {
	const parts = text.match(/[^.!?:]+[.!?:]+["']?|[^.!?:]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
	const chunks = [];
	for (const part of parts) {
		const last = chunks[chunks.length - 1];
		if (last && last.length + part.length < 90 && !/[.!?]$/.test(last)) chunks[chunks.length - 1] = `${last} ${part}`;
		else chunks.push(part);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	let at = lead;
	return chunks.map((c) => { const cue = [at, c]; at += (c.length / total) * seconds; return /** @type {[number, string]} */ (cue); });
}

const LEAD = 0.6; // silence before the narration starts
const TAIL = 1.4; // and after it ends
const only = process.argv.slice(2);
for (const scene of SCENES) {
	if (only.length && !only.some((o) => scene.id.includes(o))) continue;
	const track = await voice(scene);
	const spoken = await duration(track);
	const seconds = Math.ceil(Math.max(scene.min, LEAD + spoken + TAIL));
	console.log(`${scene.id.padEnd(16)} ${seconds}s (narration ${spoken.toFixed(1)}s)`);
	const video = join(OUT, `${scene.id}.video.mp4`);
	await record({ out: video, url: scene.url, seconds, captions: captionsFor(scene.say, spoken, LEAD), act: scene.act && ((p) => scene.act(p, seconds, spoken)),
		setup: scene.setup && ((p) => scene.setup(p, seconds)) });
	await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", track,
		"-filter_complex", `[1:a]aresample=48000,adelay=${LEAD * 1000}:all=1,apad[a]`, "-map", "0:v", "-map", "[a]",
		"-t", String(seconds), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2", join(OUT, `${scene.id}.mp4`)]);
}

const list = join(OUT, "scenes.txt");
await writeFile(list, SCENES.map((s) => `file '${join(OUT, `${s.id}.mp4`)}'`).join("\n") + "\n");
const final = join(OUT, "tower-demo.mp4");
const joined = join(OUT, "joined.mp4");
await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
// Normalize to the usual -16 LUFS for online video; the TTS comes out quiet.
await run("ffmpeg", ["-y", "-loglevel", "error", "-i", joined, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
	"-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", final]);
const total = await duration(final);
console.log(`\n${final}  ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}`);
if (total < 300 || total > 600) console.error("WARNING: outside the 5 to 10 minute limit");
