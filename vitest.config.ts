import { defineConfig } from 'vitest/config';

// Unit tests only — the acceptance tests under tests/acceptance have their
// own config (vitest.acceptance.config.ts) because they spawn the example
// apps and need long timeouts.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts']
	}
});
