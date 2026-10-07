export function schema(sql: SqlStorage) {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS plans (
			id TEXT PRIMARY KEY, agent TEXT NOT NULL, task TEXT NOT NULL, claims TEXT NOT NULL,
			status TEXT NOT NULL, blocked_by TEXT NOT NULL DEFAULT '[]',
			fork TEXT, base TEXT, created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS plans_status ON plans (status, created_at);
		CREATE TABLE IF NOT EXISTS lands (
			sha TEXT PRIMARY KEY, plan_id TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL,
			summary TEXT NOT NULL, evidence TEXT NOT NULL, landed_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS land_paths (sha TEXT NOT NULL, path TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS land_paths_path ON land_paths (path);
		CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL,
			plan_id TEXT, agent TEXT, data TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS events_plan ON events (plan_id, seq);
	`);
	// Added after plans existed; each fails harmlessly once its column is there.
	for (const column of ["amendment TEXT", "last_seen_at INTEGER", "ttl INTEGER", "review TEXT"]) {
		try {
			sql.exec(`ALTER TABLE plans ADD COLUMN ${column}`);
		} catch {}
	}
	// Plans in flight when leases arrived start theirs now, rather than expiring at once.
	sql.exec("UPDATE plans SET last_seen_at = ? WHERE last_seen_at IS NULL AND status IN ('holding', 'cleared')", Date.now());
}
