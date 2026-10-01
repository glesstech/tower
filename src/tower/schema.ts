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
	`);
	// Added after plans existed; fails harmlessly once the column is there.
	try {
		sql.exec("ALTER TABLE plans ADD COLUMN amendment TEXT");
	} catch {}
}
