// Node-only helpers for checking what isomorphic-git wrote into a MemoryFS against real git.

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import git from "isomorphic-git";
import type { MemoryFS } from "../../src/memory-fs";

export const run = promisify(execFile);

export const tempDir = () => mkdtemp(join(tmpdir(), "tower-test-"));

// Copy a repo's .git directory out of a MemoryFS onto disk, so the git CLI can inspect it.
export async function dumpGitDir(fs: MemoryFS, dir: string): Promise<string> {
	const src = `${dir}/.git`;
	const dest = join(await tempDir(), ".git");
	for (const [path, entry] of fs.entries) {
		if (path !== src && !path.startsWith(`${src}/`)) continue;
		const target = join(dest, path.slice(src.length));
		if (entry.kind === "dir") await mkdir(target, { recursive: true });
		else {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, entry.data);
		}
	}
	return dest;
}

// `git fsck --strict` rejects malformed trees (zero-padded modes, bad entry order, duplicates).
export async function fsck(fs: MemoryFS, dir: string) {
	const gitDir = await dumpGitDir(fs, dir);
	return run("git", [`--git-dir=${gitDir}`, "fsck", "--strict", "--full", "--no-dangling"]);
}

// Flatten a tree into path -> contents.
export async function readSnapshot(fs: MemoryFS, dir: string, oid: string | null, prefix = ""): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	if (!oid) return out;
	for (const e of (await git.readTree({ fs, dir, oid })).tree) {
		if (e.type === "tree") Object.assign(out, await readSnapshot(fs, dir, e.oid, `${prefix}${e.path}/`));
		else out[prefix + e.path] = new TextDecoder().decode((await git.readBlob({ fs, dir, oid: e.oid })).blob);
	}
	return out;
}

// An isomorphic-git HTTP client that serves fetches from a local repo through
// `git upload-pack --stateless-rpc`, i.e. smart HTTP without a server or a port.
export function localHttp(repoDir: string) {
	const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const uploadPack = (args: string[], input?: Uint8Array) =>
		new Promise<Buffer>((resolve, reject) => {
			const child = spawn("git", ["upload-pack", "--stateless-rpc", ...args, repoDir]);
			const chunks: Buffer[] = [];
			child.stdout.on("data", (c) => chunks.push(c));
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`upload-pack exited ${code}`))));
			child.stdin.end(input);
		});

	return {
		async request({ url, method, body }: { url: string; method?: string; body?: AsyncIterable<Uint8Array> | Uint8Array[] }) {
			let data: Buffer;
			if (url.endsWith("/info/refs?service=git-upload-pack")) {
				const refs = await uploadPack(["--advertise-refs"]);
				data = Buffer.concat([Buffer.from(`${pkt("# service=git-upload-pack\n")}0000`), refs]);
			} else if (url.endsWith("/git-upload-pack") && method === "POST") {
				const parts: Uint8Array[] = [];
				if (body) for await (const chunk of body) parts.push(chunk);
				data = await uploadPack([], Buffer.concat(parts));
			} else {
				return { url, method, statusCode: 404, statusMessage: "Not Found", headers: {}, body: [] };
			}
			const type = url.includes("info/refs") ? "advertisement" : "result";
			return {
				url,
				method,
				statusCode: 200,
				statusMessage: "OK",
				headers: { "content-type": `application/x-git-upload-pack-${type}` },
				body: [new Uint8Array(data)],
			};
		},
	};
}
