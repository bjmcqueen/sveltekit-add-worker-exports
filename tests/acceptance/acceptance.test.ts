/**
 * Acceptance tests for the example apps (SvelteKit v2 in `example/`,
 * SvelteKit v3 in `example-v3/`). Each app is exercised in both modes:
 *
 * - **dev mode**: `vite dev` with the plugin's wrangler sidecar. Verifies
 *   the DO echo + workflow reply over WebSocket against the sidecar, that
 *   `+server.ts` routes reach the sidecar's DO/Workflow bindings through
 *   `platform.env` (dev-registry routing), and the `/__scheduled` endpoint.
 * - **built mode**: `vite build` then `wrangler dev` serving the merged
 *   `_worker.js` — the exact bundle that gets deployed. Verifies the same
 *   behavior through the production worker, plus the build artifacts.
 *
 * Everything runs headless: plain `fetch` and Node's built-in `WebSocket`.
 * Suites run sequentially (see vitest.acceptance.config.ts) because the dev
 * sidecar always binds port 8787 and both apps register the same worker
 * name in the wrangler dev registry.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
	type ManagedProcess,
	postWithRetry,
	runToCompletion,
	startProcess,
	waitForHttp,
	waitForPortClosed,
	WsClient
} from './helpers';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** Port the plugin's dev sidecar listens on (the plugin's default). */
const SIDECAR_PORT = 8787;

const APPS = [
	{ name: 'example', vitePort: 5301, previewPort: 5302, inspectorPort: 9401 },
	{ name: 'example-v3', vitePort: 5303, previewPort: 5304, inspectorPort: 9402 }
];

const uniqueRoom = () => `room-${randomUUID()}`;
const botReply = (message: string) => `🤖 I heard you say: "${message}"`;

for (const app of APPS) {
	const dir = join(ROOT, app.name);

	describe(`${app.name} — dev mode (vite dev + wrangler sidecar)`, () => {
		const viteUrl = `http://localhost:${app.vitePort}`;
		const sidecarUrl = `http://localhost:${SIDECAR_PORT}`;
		let proc: ManagedProcess;

		beforeAll(async () => {
			proc = startProcess(['vite', 'dev', '--port', String(app.vitePort), '--strictPort'], dir);
			try {
				await waitForHttp(`${viteUrl}/`, 120_000, (res) => res.ok);
				// The sidecar's fetch handler 404s on "/" — any response means it's up.
				await waitForHttp(`${sidecarUrl}/`, 60_000);
			} catch (error) {
				await proc.kill();
				throw new Error(`${error}\n--- vite dev output ---\n${proc.output()}`);
			}
		});

		afterAll(async () => {
			await proc?.kill();
			await waitForPortClosed(`${sidecarUrl}/`, 30_000);
			await waitForPortClosed(`${viteUrl}/`, 30_000);
		});

		test('serves the app page', async () => {
			const res = await fetch(`${viteUrl}/`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('Echo Chat');
		});

		test('Durable Object echoes over WebSocket and the Workflow replies', async () => {
			const ws = await WsClient.connect(`ws://localhost:${SIDECAR_PORT}/ws/${uniqueRoom()}`);
			try {
				ws.send('hello');
				// Echo proves the EchoDO named export runs in the sidecar; the bot
				// reply proves BotWorkflow ran and called back into the DO via RPC.
				await ws.waitFor((m) => m === 'hello', 15_000);
				await ws.waitFor((m) => m === botReply('hello'), 30_000);
			} finally {
				ws.close();
			}
		});

		test('+server.ts route reaches the DO via platform.env (dev registry)', async () => {
			const room = uniqueRoom();
			const ws = await WsClient.connect(`ws://localhost:${SIDECAR_PORT}/ws/${room}`);
			try {
				const res = await postWithRetry(`${viteUrl}/api/say/${room}`, 'hi from the route');
				expect(await res.text()).toBe('ok');
				await ws.waitFor((m) => m === '🤖 hi from the route', 15_000);
			} finally {
				ws.close();
			}
		});

		test('+server.ts route creates a Workflow via platform.env (dev registry)', async () => {
			const room = uniqueRoom();
			const ws = await WsClient.connect(`ws://localhost:${SIDECAR_PORT}/ws/${room}`);
			try {
				const res = await postWithRetry(`${viteUrl}/api/bot/${room}`, 'ping');
				expect(await res.text()).toMatch(/\S/); // the workflow instance id
				await ws.waitFor((m) => m === botReply('ping'), 30_000);
			} finally {
				ws.close();
			}
		});

		test('scheduled handler can be fired through the sidecar', async () => {
			const res = await fetch(`${sidecarUrl}/__scheduled?cron=*+*+*+*+*`);
			expect(res.status).toBe(200);
		});
	});

	describe(`${app.name} — built mode (vite build + wrangler dev)`, () => {
		const baseUrl = `http://localhost:${app.previewPort}`;
		const outDir = join(dir, '.svelte-kit', 'cloudflare');
		let proc: ManagedProcess;

		beforeAll(async () => {
			await rm(outDir, { recursive: true, force: true });
			await runToCompletion(['vite', 'build'], dir);
			proc = startProcess(
				[
					'wrangler',
					'dev',
					'--port',
					String(app.previewPort),
					'--inspector-port',
					String(app.inspectorPort),
					'--test-scheduled'
				],
				dir
			);
			try {
				await waitForHttp(`${baseUrl}/`, 120_000, (res) => res.ok);
			} catch (error) {
				await proc.kill();
				throw new Error(`${error}\n--- wrangler dev output ---\n${proc.output()}`);
			}
		});

		afterAll(async () => {
			await proc?.kill();
			await waitForPortClosed(`${baseUrl}/`, 30_000);
		});

		test('merges the named exports into _worker.js', async () => {
			const worker = await readFile(join(outDir, '_worker.js'), 'utf-8');
			expect(worker).toContain(`export * from './_extra_exports.js'`);
			const extra = await readFile(join(outDir, '_extra_exports.js'), 'utf-8');
			for (const className of ['EchoDO', 'BotWorkflow', 'VoicedAgent']) {
				expect(extra).toContain(className);
			}
			const assetsIgnore = await readFile(join(outDir, '.assetsignore'), 'utf-8');
			for (const entry of [
				'_sveltekit_worker.js',
				'_sveltekit_worker.js.map',
				'_extra_exports.js',
				'_extra_exports.js.map'
			]) {
				expect(assetsIgnore).toContain(entry);
			}
		});

		test('serves the app page', async () => {
			const res = await fetch(`${baseUrl}/`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('Echo Chat');
		});

		test('WebSocket through the SvelteKit route reaches the DO, Workflow replies', async () => {
			const ws = await WsClient.connect(`ws://localhost:${app.previewPort}/ws/${uniqueRoom()}`);
			try {
				ws.send('hello');
				await ws.waitFor((m) => m === 'hello', 15_000);
				await ws.waitFor((m) => m === botReply('hello'), 30_000);
			} finally {
				ws.close();
			}
		});

		test('+server.ts route reaches the DO via platform.env', async () => {
			const room = uniqueRoom();
			const ws = await WsClient.connect(`ws://localhost:${app.previewPort}/ws/${room}`);
			try {
				const res = await postWithRetry(`${baseUrl}/api/say/${room}`, 'hi from the route');
				expect(await res.text()).toBe('ok');
				await ws.waitFor((m) => m === '🤖 hi from the route', 15_000);
			} finally {
				ws.close();
			}
		});

		test('+server.ts route creates a Workflow via platform.env', async () => {
			const room = uniqueRoom();
			const ws = await WsClient.connect(`ws://localhost:${app.previewPort}/ws/${room}`);
			try {
				const res = await postWithRetry(`${baseUrl}/api/bot/${room}`, 'ping');
				expect(await res.text()).toMatch(/\S/);
				await ws.waitFor((m) => m === botReply('ping'), 30_000);
			} finally {
				ws.close();
			}
		});

		test('scheduled handler is merged onto the default export', async () => {
			const res = await fetch(`${baseUrl}/__scheduled?cron=*+*+*+*+*`);
			expect(res.status).toBe(200);
		});

		test('plugin bundles are not served as public assets', async () => {
			for (const path of ['/_extra_exports.js', '/_sveltekit_worker.js.map']) {
				const res = await fetch(`${baseUrl}${path}`);
				expect(res.status, `${path} must not be publicly served`).toBe(404);
			}
		});
	});
}
