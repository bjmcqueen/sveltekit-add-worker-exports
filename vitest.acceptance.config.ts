import { defineConfig } from 'vitest/config';

// Acceptance tests spawn the example apps (vite dev / vite build / wrangler
// dev) and drive them over HTTP and WebSocket. They must run sequentially:
// the plugin's dev sidecar always binds port 8787, and both example apps
// register the same worker name in the wrangler dev registry.
export default defineConfig({
	test: {
		include: ['tests/acceptance/**/*.test.ts'],
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 300_000
	}
});
