import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SubagentRuntime, type Child, type ChildSession, type History } from "../extensions/subagent/runtime.ts";
import { SubagentStorage, type ArchiveRef, type StorageContext } from "../extensions/subagent/storage.ts";

const input = { task: "ARCHIVE_FIRST", role: "scout" as const, model: { provider: "fixture", id: "fixture" }, thinking: "off", tools: ["read"], timeoutMs: 5000, maxTurns: 3 };
function session(child: Child, output = "ARCHIVE_DONE"): ChildSession {
	const messages: History = structuredClone(child.history);
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	return {
		messages, isStreaming: false,
		async prompt(task) {
			for (const message of [
				{ role: "user", content: task, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" },
			] as History) {
				messages.push(message);
				for (const listener of listeners) listener({ type: "message_end", message });
			}
		},
		async steer() {}, async abort() {}, dispose() {},
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}
const entry = (runtime: SubagentRuntime) => ({ type: "message", message: { role: "toolResult", toolName: "pi_subagent", isError: false, details: runtime.snapshot() } }) as SessionEntry;
async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: { maxBytes?: number; retentionDays?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-storage-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SubagentStorage({ root, ...options });
	const context: StorageContext = { store, parentId: "parent-one", cwd: root, branchId: "branch-one" };
	const runtime = new SubagentRuntime();
	await runtime.restore([], context);
	t.after(() => runtime.shutdown());
	return { store, context, runtime, root };
}

test("archives settle without parent collection and snapshots contain references, not history", async (t) => {
	const { runtime, store } = await fixture(t);
	const id = runtime.spawn(input, async (child) => session(child));
	const deadline = Date.now() + 5000;
	while (runtime.get(id).status === "running" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
	const child = runtime.get(id);
	assert.equal(child.status, "completed");
	assert.equal(await readFile(join(child.archiveDir!, "result.md"), "utf8"), "ARCHIVE_DONE");
	assert.equal(JSON.parse(await readFile(join(child.archiveDir!, "meta.json"), "utf8")).child.status, "completed");
	const events = (await readFile(join(child.archiveDir!, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(events.some((event) => typeof event.event?.message?.content === "string" && event.event.message.content.startsWith("ARCHIVE_FIRST\n\n[Subagent run context]\n") && event.event.message.content.includes(join(child.archiveDir!, "artifacts"))));
	assert.equal(events.at(-1).type, "run_end");
	assert.equal((await store.readHistory(child.checkpoint!)).length, 2);
	assert.deepEqual(runtime.snapshot().children[0]!.history, []);
	assert.ok(JSON.stringify(runtime.snapshot()).length < 2000);
	assert.deepEqual(await readdir(join(child.archiveDir!, "artifacts")), []);
});

test("continuation and branch forks use immutable checkpoints and unique run IDs", async (t) => {
	const { runtime, context, store } = await fixture(t);
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const first = entry(runtime);
	const firstRef = runtime.get(id).checkpoint!;
	await runtime.send(id, "FUTURE_BRANCH", async (child) => session(child));
	const running = entry(runtime);
	await runtime.wait([id], 5000);
	const futureRef = runtime.get(id).checkpoint!;
	assert.notDeepEqual(firstRef, futureRef);
	assert.match(JSON.stringify(await store.readHistory(futureRef)), /FUTURE_BRANCH/);
	await runtime.restore([running], context);
	assert.equal(runtime.get(id).status, "stopped");
	assert.doesNotMatch(JSON.stringify(runtime.get(id).history), /FUTURE_BRANCH/);
	assert.equal(await readFile(join(store.path(futureRef), "result.md"), "utf8"), "ARCHIVE_DONE");
	await runtime.restore([first], context);
	assert.doesNotMatch(JSON.stringify(runtime.get(id).history), /FUTURE_BRANCH/);
	await runtime.send(id, "OTHER_BRANCH", async (child) => session(child));
	await runtime.wait([id], 5000);
	assert.notDeepEqual(runtime.get(id).checkpoint, futureRef);
	assert.match(JSON.stringify(await store.readHistory(runtime.get(id).checkpoint!)), /OTHER_BRANCH/);
	assert.doesNotMatch(JSON.stringify(await store.readHistory(runtime.get(id).checkpoint!)), /FUTURE_BRANCH/);
	assert.doesNotMatch(JSON.stringify(await store.readHistory(firstRef)), /OTHER_BRANCH|FUTURE_BRANCH/);
});

test("large histories remain resumable on disk and complete output is preserved", async (t) => {
	const { runtime, store } = await fixture(t);
	const output = "中".repeat(800_000);
	const id = runtime.spawn(input, async (child) => session(child, output));
	await runtime.wait([id], 5000);
	const child = runtime.get(id);
	assert.equal(child.status, "completed");
	assert.equal(child.resumable, true);
	assert.ok(Buffer.byteLength(child.output) < 16_500);
	assert.equal(await readFile(join(child.archiveDir!, "result.md"), "utf8"), output);
	assert.ok(Buffer.byteLength(JSON.stringify(await store.readHistory(child.checkpoint!))) > 2_000_000);
	assert.ok(Buffer.byteLength(JSON.stringify(runtime.snapshot())) < 20_000);
	assert.ok(Buffer.byteLength(runtime.snapshot().children[0]!.output) < 2200, "parent polls store a compact preview, with the full result in its archive");
});

test("polling during archive settlement keeps the previous checkpoint until writes finish", async (t) => {
	const { runtime, store, context } = await fixture(t);
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const firstRef = runtime.get(id).checkpoint;
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const settling = new Promise<void>((resolve) => { started = resolve; });
	const begin = store.begin.bind(store);
	store.begin = async (...args) => {
		const archive = await begin(...args);
		const finish = archive.finish.bind(archive);
		archive.finish = async (...result) => { started(); await gate; await finish(...result); };
		return archive;
	};
	await runtime.send(id, "NOT_COLLECTED_YET", async (child) => session(child, "x".repeat(2_100_000)));
	await settling;
	const during = entry(runtime);
	try {
		assert.equal(runtime.get(id).status, "running");
		assert.deepEqual(runtime.snapshot().children[0]!.checkpoint, firstRef);
		assert.ok(JSON.stringify(runtime.snapshot()).length < 20_000);
	} finally { release(); }
	await runtime.wait([id], 5000);
	assert.notDeepEqual(runtime.get(id).checkpoint, firstRef);
	await runtime.restore([during], context);
	assert.equal(runtime.get(id).status, "stopped");
	assert.doesNotMatch(JSON.stringify(runtime.get(id).history), /NOT_COLLECTED_YET/);
});

test("missing or corrupt checkpoints disable continuation without reading a newer run", async (t) => {
	const { runtime, context, store } = await fixture(t);
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const snapshot = entry(runtime);
	const path = join(store.path(runtime.get(id).checkpoint!), "checkpoint.json");
	await writeFile(path, "broken JSON");
	await runtime.restore([snapshot], context);
	let prompted = false;
	await runtime.send(id, "must not run from corrupt history", async (child) => { prompted = true; return session(child); });
	await runtime.wait([id], 5000);
	assert.equal(prompted, false);
	assert.equal(runtime.get(id).resumable, false);
	assert.match(runtime.get(id).error!, /Cannot restore/);
	await assert.rejects(runtime.send(id, "again", async (child) => session(child)), /checkpoint/);
	await rm(path);
	await runtime.restore([snapshot], context);
	assert.equal(runtime.get(id).resumable, false);
	assert.equal(runtime.get(id).output, "ARCHIVE_DONE");
});

test("version 1 inline checkpoints upgrade and ephemeral runs create no archive", async (t) => {
	const { root, context } = await fixture(t);
	const memory = new SubagentRuntime();
	const id = memory.spawn(input, async (child) => session(child));
	await memory.wait([id], 5000);
	assert.deepEqual(await readdir(root), []);
	assert.equal(memory.get(id).archive, undefined);
	const legacy = entry(memory);
	if (legacy.type === "message" && legacy.message.role === "toolResult") (legacy.message.details as { version: number }).version = 1;
	const upgraded = new SubagentRuntime();
	await upgraded.restore([legacy], context);
	await upgraded.send(id, "UPGRADED", async (child) => session(child));
	await upgraded.wait([id], 5000);
	assert.equal(upgraded.get(id).status, "completed");
	assert.match(JSON.stringify(await context.store.readHistory(upgraded.get(id).checkpoint!)), /ARCHIVE_FIRST/);
	assert.ok(upgraded.get(id).checkpoint);
});

test("archive creation and queued write failures are explicit and release capacity", async (t) => {
	const { runtime, root } = await fixture(t);
	await writeFile(join(root, "parent-one"), "not a directory");
	let prompted = false;
	const id = runtime.spawn(input, async (child) => { prompted = true; return session(child); });
	await runtime.wait([id], 5000);
	assert.equal(runtime.get(id).status, "failed");
	assert.equal(prompted, false);
	await rm(join(root, "parent-one"));
	const failed = runtime.spawn(input, async (child) => {
		const path = join(child.archiveDir!, "events.jsonl");
		await rm(path);
		await mkdir(path);
		return session(child);
	});
	await runtime.wait([failed], 5000);
	assert.equal(runtime.get(failed).status, "failed");
	assert.match(runtime.get(failed).error!, /archive failed/);
	assert.equal(runtime.get(failed).checkpoint, undefined);
	const good = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([good], 5000);
	assert.equal(runtime.get(good).status, "completed");
});

test("archive references cannot traverse paths or follow checkpoint symlinks", async (t) => {
	const { store, runtime, root } = await fixture(t);
	assert.throws(() => store.path({ parentId: "..", childId: "x", runId: "y" }), /Invalid/);
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const ref = runtime.get(id).checkpoint!;
	const path = join(store.path(ref), "checkpoint.json");
	await rm(path);
	await writeFile(join(root, "outside.json"), "{}");
	await symlink(join(root, "outside.json"), path);
	await assert.rejects(store.readHistory(ref), /regular file/);
});

test("retention and capacity prune old inactive archives while preserving active, referenced and foreign data", async (t) => {
	const { store, context, runtime, root } = await fixture(t, { retentionDays: 1, maxBytes: 0 });
	const child = { ...input, id: "child", status: "completed", output: "done", history: [], resumable: true, turn: 1 } as Child;
	const create = async (parentId: string, pid: number, time = 1) => {
		const ref: ArchiveRef = { parentId, childId: "child", runId: "run" };
		const archive = await store.begin(ref, { ...context, parentId }, child, "test");
		await archive.finish(child, "done");
		const file = join(store.path(ref), "meta.json");
		const meta = JSON.parse(await readFile(file, "utf8"));
		await writeFile(file, JSON.stringify({ ...meta, pid, createdAt: time, completedAt: time }));
		if (pid !== process.pid) {
			for (const name of await readdir(join(root, parentId))) if (name.startsWith(".lease-")) await rm(join(root, parentId, name));
		}
		return store.path(ref);
	};
	const old = await create("old", 2147483647);
	const young = await create("young", 2147483647, Date.now());
	const active = await create("active", process.pid);
	const referenced = await create("referenced", 2147483647);
	const resumed = await create("resumed", 2147483647);
	await new SubagentStorage({ root }).readHistory({ parentId: "resumed", childId: "child", runId: "run" });
	await mkdir(join(root, "foreign", "child", "run"), { recursive: true });
	await writeFile(join(root, "foreign", "child", "run", "keep.txt"), "keep");
	await symlink(join(root, "foreign"), join(root, "linked"));
	await store.prune(Date.now(), new Set(["referenced"]));
	await assert.rejects(readFile(join(old, "meta.json")), { code: "ENOENT" });
	assert.ok(await readFile(join(young, "meta.json")), "age cleanup preserves recent runs");
	await new SubagentStorage({ root, retentionDays: 0, maxBytes: 1 }).prune(Date.now(), new Set(["referenced"]));
	await assert.rejects(readFile(join(young, "meta.json")), { code: "ENOENT" });
	assert.ok(await readFile(join(active, "meta.json")));
	assert.ok(await readFile(join(referenced, "meta.json")));
	assert.ok(await readFile(join(resumed, "meta.json")), "another process's cleanup must preserve resumed archives");
	assert.equal(await readFile(join(root, "foreign", "child", "run", "keep.txt"), "utf8"), "keep");
	await runtime.shutdown();
});

test("storage environment defaults and limits are explicit", () => {
	assert.match(SubagentStorage.fromEnvironment({}).root, /\.pi\/subagents$/);
	assert.equal(SubagentStorage.fromEnvironment({ PI_SUBAGENT_RETENTION_DAYS: "0", PI_SUBAGENT_MAX_STORAGE_MB: "0" }).maxBytes, 0);
	assert.throws(() => SubagentStorage.fromEnvironment({ PI_SUBAGENT_RETENTION_DAYS: "garbage" }), /nonnegative/);
});

test("cold listing and idle children retain no history bodies; only a continued child reads its checkpoint", async (t) => {
	const { runtime, store, context } = await fixture(t);
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		const id = runtime.spawn(input, async (child) => session(child, `BODY_${i}_` + "x".repeat(500_000)));
		ids.push(id);
		await runtime.wait([id], 5000);
		assert.deepEqual(runtime.get(id).history, []);
	}
	let reads = 0;
	const read = store.readHistory.bind(store);
	store.readHistory = async (ref) => { reads++; return read(ref); };
	await runtime.restore([entry(runtime)], context);
	assert.equal(reads, 0, "restoration must not parse every archived conversation");
	assert.ok(JSON.stringify(runtime.snapshot()).length < 75_000);
	await runtime.send(ids[2]!, "ONLY_THIRD", async (child) => {
		assert.match(JSON.stringify(child.history), /BODY_2_/);
		assert.doesNotMatch(JSON.stringify(child.history), /BODY_0_|BODY_1_|BODY_3_/);
		return session(child);
	});
	await runtime.wait([ids[2]!], 5000);
	assert.equal(runtime.get(ids[2]!).status, "completed");
	assert.equal(reads, 1);
	assert.deepEqual(runtime.get(ids[2]!).history, []);
});

test("structurally corrupt history never reaches a child SDK session or replaces its valid checkpoint", async (t) => {
	const { runtime, context, store } = await fixture(t);
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const ref = runtime.get(id).checkpoint!;
	await writeFile(join(store.path(ref), "checkpoint.json"), JSON.stringify({ version: 1, ref, history: [null] }));
	await runtime.restore([entry(runtime)], context);
	let created = false;
	await runtime.send(id, "MUST_NOT_RUN", async (child) => { created = true; return session(child); });
	await runtime.wait([id], 5000);
	assert.equal(created, false);
	assert.equal(runtime.get(id).status, "failed");
	assert.equal(runtime.get(id).resumable, false);
	assert.deepEqual(runtime.get(id).checkpoint, ref);
	await assert.rejects(readFile(join(runtime.get(id).archiveDir!, "checkpoint.json")), { code: "ENOENT" });
});

test("archive settlement never sends stop or follow-up calls to a disposed SDK session", async (t) => {
	for (const action of ["stop", "send"] as const) {
		const { runtime, store } = await fixture(t);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const settling = new Promise<void>((resolve) => { started = resolve; });
		const begin = store.begin.bind(store);
		let first = true;
		store.begin = async (...args) => {
			const archive = await begin(...args);
			if (first) {
				first = false;
				const finish = archive.finish.bind(archive);
				archive.finish = async (...result) => { started(); await gate; await finish(...result); };
			}
			return archive;
		};
		let disposed = false;
		const id = runtime.spawn(input, async (child) => {
			const childSession = session(child);
			childSession.dispose = () => { disposed = true; };
			childSession.abort = async () => { assert.equal(disposed, false, "must not abort after disposal"); };
			return childSession;
		});
		await settling;
		const operation = action === "stop" ? runtime.stop(id) : runtime.send(id, "SETTLED_FOLLOWUP", async (child) => session(child));
		release();
		await operation;
		await runtime.wait([id], 5000);
		assert.equal(runtime.get(id).status, "completed");
		assert.equal(runtime.get(id).turn, action === "stop" ? 1 : 2);
	}
});

test("session leases release independently and inactive archives can be reclaimed before Pi exits", async (t) => {
	const { runtime, root, store } = await fixture(t, { retentionDays: 0, maxBytes: 1 });
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const ref = runtime.get(id).checkpoint!;
	const otherSession = new SubagentStorage({ root });
	await otherSession.checkHistory(ref);
	await store.release();
	await store.prune();
	assert.ok(await readFile(join(store.path(ref), "result.md")), "another live holder still protects this run");
	await otherSession.release();
	await store.prune();
	await assert.rejects(readFile(join(store.path(ref), "result.md")), { code: "ENOENT" });
	assert.deepEqual(await readdir(root), [], "empty archive directories are also reclaimed");
});

test("disabled retention performs no archive traversal", async (t) => {
	const { root } = await fixture(t);
	const file = join(root, "not-a-directory");
	await writeFile(file, "archive root deliberately cannot be traversed");
	await new SubagentStorage({ root: file, retentionDays: 0, maxBytes: 0 }).prune();
});

test("full result pages preserve Unicode and line boundaries without loading continuation or advancing a branch", async (t) => {
	const { runtime, store, context } = await fixture(t);
	const text = "😀汉字\n".repeat(1500) + "x".repeat(40000) + "\nEND";
	const id = runtime.spawn(input, async (child) => session(child, text));
	const uncollected = entry(runtime);
	await runtime.wait([id], 5000);
	await runtime.restore([uncollected], context);
	const before = runtime.snapshot();
	store.readHistory = async () => { throw new Error("report retrieval must never load continuation"); };
	let recovered = "", offset = 0, pages = 0;
	for (;;) {
		const page = await runtime.result(id, offset);
		assert.ok(Buffer.byteLength(page.text) <= 16_384);
		assert.ok(page.text.split("\n").length <= 400);
		assert.doesNotMatch(page.text, /�/);
		recovered += page.text;
		pages++;
		if (page.nextOffset === undefined) break;
		assert.ok(page.nextOffset > offset);
		offset = page.nextOffset;
		assert.ok(pages < 30);
	}
	assert.equal(recovered, text);
	assert.ok(pages > 2);
	assert.deepEqual(runtime.snapshot(), before);
	assert.equal(runtime.get(id).status, "stopped");
	await assert.rejects(runtime.result(id, 1), /UTF-8/);
	await assert.rejects(runtime.result(id, text.length * 100), /exceeds/);
	const ref = runtime.get(id).archive!;
	runtime.forget(id);
	assert.equal(await readFile(join(store.path(ref), "result.md"), "utf8"), text);
});

test("a session acquired between cleanup's last observation and deletion retains its archive", async (t) => {
	const { runtime, root, store } = await fixture(t, { retentionDays: 0, maxBytes: 1 });
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const ref = runtime.get(id).checkpoint!;
	await store.release();
	const observer = store as unknown as { hasActiveLease(parentId: string): Promise<boolean> };
	const inspect = observer.hasActiveLease.bind(store);
	let scans = 0, proceed!: () => void, observed!: () => void;
	const observedLastCheck = new Promise<void>((resolve) => { observed = resolve; });
	const gate = new Promise<void>((resolve) => { proceed = resolve; });
	observer.hasActiveLease = async (parentId) => {
		const alive = await inspect(parentId);
		if (++scans === 2) { observed(); await gate; }
		return alive;
	};
	const cleanup = store.prune();
	await observedLastCheck;
	const resumed = new SubagentStorage({ root });
	try { assert.equal((await resumed.readHistory(ref)).length, 2); }
	finally { proceed(); }
	await cleanup;
	assert.equal(await readFile(join(store.path(ref), "result.md"), "utf8"), "ARCHIVE_DONE");
	await resumed.release();
});

test("a quarantined run left by interrupted cleanup can be restored without adopting another run", async (t) => {
	const { runtime, root, store } = await fixture(t);
	const id = runtime.spawn(input, async (child) => session(child));
	await runtime.wait([id], 5000);
	const ref = runtime.get(id).checkpoint!;
	await store.release();
	await rename(store.path(ref), `${store.path(ref)}.pruning`);
	const resumed = new SubagentStorage({ root });
	assert.equal((await resumed.readHistory(ref)).length, 2);
	assert.equal(await readFile(join(store.path(ref), "result.md"), "utf8"), "ARCHIVE_DONE");
	await resumed.release();
});
