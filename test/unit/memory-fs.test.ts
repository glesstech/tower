import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { MemoryFS } from "../../src/memory-fs";
import { fsck, localHttp, run, tempDir } from "./git-helpers";

describe("MemoryFS errors carry Node-style codes", () => {
	// isomorphic-git branches on `err.code === "ENOENT"`; the Cloudflare docs helper threw bare Errors.
	const codeOf = (p: Promise<unknown>) => p.then(() => null, (err) => err.code);

	it("ENOENT for missing paths", async () => {
		const fs = new MemoryFS();
		expect(await codeOf(fs.readFile("/nope"))).toBe("ENOENT");
		expect(await codeOf(fs.stat("/nope"))).toBe("ENOENT");
		expect(await codeOf(fs.lstat("/nope"))).toBe("ENOENT");
		expect(await codeOf(fs.readdir("/nope"))).toBe("ENOENT");
		expect(await codeOf(fs.unlink("/nope"))).toBe("ENOENT");
		expect(await codeOf(fs.mkdir("/a/b"))).toBe("ENOENT");
	});

	it("ENOTDIR, EISDIR and ENOTEMPTY", async () => {
		const fs = new MemoryFS();
		await fs.writeFile("/d/f", "x");
		expect(await codeOf(fs.readdir("/d/f"))).toBe("ENOTDIR");
		expect(await codeOf(fs.readFile("/d"))).toBe("EISDIR");
		expect(await codeOf(fs.unlink("/d"))).toBe("EISDIR");
		expect(await codeOf(fs.rmdir("/d"))).toBe("ENOTEMPTY");
	});

	it("readlink exists and fails cleanly (isomorphic-git binds it unconditionally)", async () => {
		const fs = new MemoryFS();
		expect(typeof fs.promises.readlink).toBe("function");
		expect(typeof fs.promises.symlink).toBe("function");
		expect(await codeOf(fs.promises.readlink("/x"))).toBe("EINVAL");
	});

	it("reads back what it wrote", async () => {
		const fs = new MemoryFS();
		await fs.writeFile("/a/b/c.txt", "hello");
		expect(await fs.readFile("/a/b/c.txt", "utf8")).toBe("hello");
		expect(await fs.readdir("/a")).toEqual(["b"]);
		expect((await fs.stat("/a/b/c.txt")).size).toBe(5);
		await fs.unlink("/a/b/c.txt");
		await fs.rmdir("/a/b");
		expect(await fs.readdir("/a")).toEqual([]);
	});
});

describe("isomorphic-git on MemoryFS", () => {
	it("git.init creates a repository", async () => {
		const fs = new MemoryFS();
		await git.init({ fs, dir: "/r", defaultBranch: "main" });
		expect(await fs.readFile("/r/.git/HEAD", "utf8")).toBe("ref: refs/heads/main\n");
		await expect(git.resolveRef({ fs, dir: "/r", ref: "main" })).rejects.toThrow(/Could not find/);
	});

	it("git.clone fetches a repository, as TrunkWorkspace.checkout does", async () => {
		const src = await tempDir();
		await run("git", ["init", "-q", "-b", "main", src]);
		await writeFile(join(src, "README.md"), "# hi\n");
		await run("git", ["-C", src, "add", "."]);
		await run("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"]);
		const { stdout } = await run("git", ["-C", src, "rev-parse", "HEAD"]);

		const fs = new MemoryFS();
		await git.clone({
			fs,
			http: localHttp(src),
			dir: "/trunk",
			url: "http://local/trunk.git",
			ref: "main",
			singleBranch: true,
			depth: 1,
			noCheckout: true,
			noTags: true,
		});
		expect(await git.resolveRef({ fs, dir: "/trunk", ref: "refs/heads/main" })).toBe(stdout.trim());
		const { blob } = await git.readBlob({ fs, dir: "/trunk", oid: stdout.trim(), filepath: "README.md" });
		expect(new TextDecoder().decode(blob)).toBe("# hi\n");
		await expect(fsck(fs, "/trunk")).resolves.toBeDefined();
	});
});
