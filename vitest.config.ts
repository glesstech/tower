import { defineConfig } from "vitest/config";

// `npm test` runs both projects: pure-logic unit tests in Node, and Durable Object tests
// inside workerd (see vitest.workers.config.ts). Neither needs a Cloudflare account.
export default defineConfig({
	test: {
		projects: [
			{ test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
			"./vitest.workers.config.ts",
		],
	},
});
