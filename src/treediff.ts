// Diff two Git trees through the Artifacts binding, descending only into subtrees whose
// hash changed. This is how the tower learns what an agent actually touched without a
// git binary, a clone, or a push-event subscription per fork.

export type Change =
	| { op: "upsert"; path: string; mode: string; hash: string }
	| { op: "delete"; path: string };

export async function diffTrees(
	repo: ArtifactsRepo,
	before: string | null,
	after: string | null,
	prefix = "",
): Promise<Change[]> {
	if (before === after) return [];
	const [a, b] = await Promise.all([readEntries(repo, before), readEntries(repo, after)]);
	const changes: Change[] = [];
	const nested: Promise<Change[]>[] = [];

	for (const name of new Set([...a.keys(), ...b.keys()])) {
		const x = a.get(name);
		const y = b.get(name);
		const path = prefix + name;
		if (x && y && x.hash === y.hash && x.mode === y.mode) continue;

		const xTree = x?.type === "tree" ? x.hash : null;
		const yTree = y?.type === "tree" ? y.hash : null;
		if (xTree || yTree) nested.push(diffTrees(repo, xTree, yTree, `${path}/`));

		if (y && y.type !== "tree") changes.push({ op: "upsert", path, mode: y.mode, hash: y.hash });
		else if (x && x.type !== "tree") changes.push({ op: "delete", path });
	}

	for (const sub of await Promise.all(nested)) changes.push(...sub);
	return changes;
}

async function readEntries(repo: ArtifactsRepo, hash: string | null) {
	const map = new Map<string, ArtifactsTreeEntry>();
	if (!hash) return map;
	const entries = await repo.readTree(hash);
	if (!entries) throw new Error(`tree not found: ${hash}`);
	for (const e of entries) map.set(e.name, e);
	return map;
}
