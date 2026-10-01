// Test entry point: just the Tower Durable Object, without the MCP routes in src/index.ts.
export { Tower } from "../../src/tower";

export default {
	async fetch() {
		return new Response("tower test worker", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
