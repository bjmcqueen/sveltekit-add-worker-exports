/// <reference path="../worker-configuration.d.ts" />

declare global {
	const __DEV_WORKER_PORT__: number;

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
		}
	}
}

// Imported as a string via wrangler's default `**/*.sql` Text module rule.
declare module '*.sql' {
	const contents: string;
	export default contents;
}

export {};
