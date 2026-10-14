// Records one scene of the demo video: opens a page in headless Chrome, runs the scene's
// actions, holds for the scene's length, and saves the take as an MP4. Every scene gets the
// same caption bar at the bottom, drawn in the page, because this ffmpeg has no text filters.
//
// Chrome is the build playwright-core installs (npx playwright-core install chromium ffmpeg);
// CHROME overrides the path.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
export const WIDTH = 1280;
export const HEIGHT = 720;
const CHROME = process.env.CHROME;

/** Draws (or replaces) the caption bar. Runs in the page. @param {string} text */
function caption(text) {
	let bar = document.getElementById("demo-caption");
	if (!bar) {
		bar = document.createElement("div");
		bar.id = "demo-caption";
		bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 48px 18px;" +
			"background:rgba(10,12,16,.82);color:#f4f4f5;font:500 22px/1.35 system-ui,-apple-system,sans-serif;" +
			"text-align:center;pointer-events:none;transition:opacity .3s";
		document.body.appendChild(bar);
	}
	bar.textContent = text;
	bar.style.opacity = text ? "1" : "0";
}

/**
 * Records `url` for `seconds`. `act(page, helpers)` drives the page; whatever time it leaves is
 * held at the end. `captions` are [secondsFromStart, text] pairs shown in turn.
 * @param {{ out: string, url: string, seconds: number, captions?: [number, string][],
 *   act?: (page: import("playwright-core").Page) => Promise<void>,
 *   setup?: (page: import("playwright-core").Page) => Promise<void>, trim?: number }} scene
 * `setup` runs before the take starts, so the page it leaves (a replay just begun, say) is the
 * first frame.
 */
export async function record({ out, url, seconds, captions = [], act, setup, trim = 0 }) {
	const dir = await mkdtemp(join(tmpdir(), "tower-demo-"));
	const browser = await chromium.launch({ executablePath: CHROME });
	try {
		const context = await browser.newContext({
			viewport: { width: WIDTH, height: HEIGHT },
			recordVideo: { dir, size: { width: WIDTH, height: HEIGHT } },
			colorScheme: "dark",
		});
		const page = await context.newPage();
		const started = Date.now();
		await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
		if (setup) await setup(page);
		await page.waitForTimeout(400);
		// Load and setup time are cut from the front of the take, so every scene opens on a drawn page.
		const loaded = (Date.now() - started) / 1000;
		const timers = captions.map(([at, text]) =>
			setTimeout(() => page.evaluate(caption, text).catch(() => {}), at * 1000));
		if (captions.length && captions[0][0] === 0) await page.evaluate(caption, captions[0][1]);
		if (act) await act(page);
		const left = loaded + seconds - (Date.now() - started) / 1000;
		if (left > 0) await page.waitForTimeout(left * 1000);
		timers.forEach(clearTimeout);
		await context.close();
		const [webm] = (await readdir(dir)).filter((f) => f.endsWith(".webm"));
		const raw = join(dir, webm);
		await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(loaded + trim), "-i", raw, "-t", String(seconds),
			"-vf", `fps=30,scale=${WIDTH}:${HEIGHT},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
			"-an", out + ".tmp.mp4"]);
		await rename(out + ".tmp.mp4", out);
	} finally {
		await browser.close();
		await rm(dir, { recursive: true, force: true });
	}
}
