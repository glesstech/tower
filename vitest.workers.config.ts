import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Durable Object tests run inside workerd. The Tower is configured here rather than from
// wrangler.jsonc: its Artifacts binding is remote-only, so tests swap in test/fake-artifacts.ts.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./test/do/main.ts",
			remoteBindings: false,
			miniflare: {
				// Must not be newer than the workerd bundled with @cloudflare/vitest-pool-workers.
				compatibilityDate: "2026-08-01",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: { TOWER: { className: "Tower", useSQLite: true } },
				bindings: { TOWER_API_KEY: "test" },
			},
		}),
	],
	test: {
		name: "do",
		include: ["test/do/**/*.test.ts"],
	},
});
