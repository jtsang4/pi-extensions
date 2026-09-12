/** Same-load comparison: optionally point at an extracted historical runtime directory. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Child, ChildSession, History } from "../extensions/subagent/runtime.ts";

const source = resolve(process.argv[2] ?? `${import.meta.dirname}/../extensions/subagent`);
const { SubagentRuntime } = await import(pathToFileURL(`${source}/runtime.ts`).href) as typeof import("../extensions/subagent/runtime.ts");
const { SubagentStorage } = await import(pathToFileURL(`${source}/storage.ts`).href) as typeof import("../extensions/subagent/storage.ts");
const artifacts = await mkdtemp(`${tmpdir()}/pi-subagent-performance-`);
const store = new SubagentStorage({ root: `${artifacts}/subagents`, retentionDays: 0, maxBytes: 0 });
const runtime = new SubagentRuntime();
const context = { store, parentId: "benchmark-parent", cwd: artifacts, branchId: "branch" };
const deadline = setTimeout(() => { console.error("PERFORMANCE_TIMEOUT"); process.exit(1); }, 30_000);
const session = (child: Child, text: string): ChildSession => {
	const messages = structuredClone(child.history);
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	return {
		messages, isStreaming: false,
		async prompt(task) {
			for (const message of [{ role: "user", content: task, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] as History) {
				messages.push(message);
				for (const listener of listeners) listener({ type: "message_end", message });
			}
		},
		async abort() {}, async steer() {}, dispose() {},
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
};
try {
	await runtime.restore([], context);
	const ids: string[] = [];
	for (let index = 0; index < 16; index++) {
		const id = runtime.spawn({ task: `TASK_${index}`, role: "scout", model: { provider: "fixture", id: "fixture" }, thinking: "off", tools: [], timeoutMs: 5000, maxTurns: 2 },
			async (child) => session(child, `BODY_${index}_` + "x".repeat(500_000)));
		ids.push(id);
		await runtime.wait([id], 5000);
		assert.equal(runtime.get(id).status, "completed");
	}
	const retainedHistoryBytes = ids.reduce((sum, id) => sum + (runtime.get(id).history.length ? Buffer.byteLength(JSON.stringify(runtime.get(id).history)) : 0), 0);
	const snapshot = runtime.snapshot();
	let bodyReads = 0, bodyBytes = 0;
	const read = store.readHistory.bind(store);
	store.readHistory = async (ref) => { bodyReads++; const history = await read(ref); bodyBytes += Buffer.byteLength(JSON.stringify(history)); return history; };
	const entry = { type: "message", message: { role: "toolResult", toolName: "pi_subagent", isError: false, details: snapshot } } as SessionEntry;
	const started = performance.now();
	await runtime.restore([entry], context);
	const restore = { milliseconds: performance.now() - started, bodyReads, bodyBytes };
	await runtime.send(ids[7]!, "ONE_FOLLOWUP", async (child) => {
		assert.match(JSON.stringify(child.history), /BODY_7_/);
		return session(child, "FOLLOWUP_DONE");
	});
	await runtime.wait([ids[7]!], 5000);
	assert.equal(runtime.get(ids[7]!).status, "completed");
	const hashes = Object.fromEntries(await Promise.all(["runtime.ts", "storage.ts"].map(async (file) => [file,
		createHash("sha256").update(await readFile(`${source}/${file}`)).digest("hex")])));
	const report = { source, node: process.versions.node, children: ids.length, payloadBytesPerChild: 500_000,
		retainedHistoryBytes, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), restore,
		bodyReadsAfterOneFollowup: bodyReads, hashes };
	await writeFile(`${artifacts}/measurements.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ artifacts, ...report }, null, 2));
} finally { await runtime.shutdown(); await store.release?.(); clearTimeout(deadline); }
