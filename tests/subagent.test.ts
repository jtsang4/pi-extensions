import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRuntime, bounded, type Child, type ChildSession, type History } from "../extensions/subagent/runtime.ts";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

const input = { task: "E2E_SUBAGENT", role: "scout" as const, model: { provider: "test", id: "test" }, thinking: "off", tools: ["read"], timeoutMs: 1000, maxTurns: 3 };
function fake(options: { hold?: boolean; error?: boolean; disposeError?: boolean } = {}) {
	let release: () => void = () => {};
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const messages: History = [];
	let disposed = false;
	let aborted = false;
	const sent: string[] = [];
	const session: ChildSession = {
		messages,
		isStreaming: true,
		async prompt(task) {
			sent.push(task);
			if (options.hold) await new Promise<void>((resolve) => { release = resolve; });
			if (options.error) throw new Error("Provider unavailable");
			const message = { role: "assistant", content: [{ type: "text", text: "E2E_SUBAGENT_DONE" }], stopReason: aborted ? "aborted" : "stop" } as History[number];
			messages.push(message);
			for (const listener of listeners) listener({ type: "message_end", message });
		},
		async steer(text) { sent.push(text); },
		async abort() { aborted = true; release(); },
		dispose() { disposed = true; if (options.disposeError) throw new Error("Dispose failed"); },
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	return { session, release: () => release(), sent, get disposed() { return disposed; } };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("subagent success, idle continuation and bounded output", async () => {
	const runtime = new SubagentRuntime();
	const children: Child[] = [];
	const factory = async (child: Child) => { children.push(child); return fake().session; };
	const id = runtime.spawn(input, factory);
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "completed");
	await runtime.send(id, "Follow up", factory);
	await runtime.wait([id], 1000);
	assert.equal(children[1]!.history.length, 1);
	assert.equal(runtime.get(id).turn, 2);
	assert.match(bounded("中".repeat(30_000)), /truncated/);
	assert.ok(Buffer.byteLength(bounded("中".repeat(30_000))) < 16_500);
	await runtime.shutdown();
});

test("capacity includes initializing workers and wait timeout does not cancel", async () => {
	const runtime = new SubagentRuntime();
	const fakes = Array.from({ length: 4 }, () => fake({ hold: true }));
	const ids = fakes.map((f) => runtime.spawn(input, async () => f.session));
	assert.throws(() => runtime.spawn(input, async () => fake().session), /Four/);
	await runtime.wait(ids, 5);
	assert.equal(runtime.get(ids[0]!).status, "running");
	await runtime.send(ids[0]!, "Steering", async () => { throw new Error("must reuse live session"); });
	assert.equal(fakes[0]!.sent[1], "Steering");
	await runtime.shutdown();
	assert.ok(fakes.every((f) => f.disposed));
	assert.ok(runtime.snapshot().children.every((c) => c.status === "stopped"));
});

test("cancelled wait leaves child live; explicit stop is idempotent", async () => {
	const runtime = new SubagentRuntime();
	const f = fake({ hold: true });
	const id = runtime.spawn(input, async () => f.session);
	const controller = new AbortController();
	const wait = runtime.wait([id], 1000, controller.signal);
	controller.abort();
	await assert.rejects(wait, /children continue/);
	assert.equal(runtime.get(id).status, "running");
	await runtime.stop(id);
	await runtime.stop(id);
	assert.equal(runtime.get(id).status, "stopped");
	assert.ok(f.disposed);
});

test("deadline stops child and provider errors are never success", async () => {
	const runtime = new SubagentRuntime();
	const f = fake({ hold: true });
	const id = runtime.spawn({ ...input, timeoutMs: 15 }, async () => f.session);
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "stopped");
	assert.match(runtime.get(id).error!, /timed out/);
	assert.ok(f.disposed);
	const failed = runtime.spawn(input, async () => fake({ error: true }).session);
	await runtime.wait([failed], 1000);
	assert.equal(runtime.get(failed).status, "failed");
	assert.match(runtime.get(failed).error!, /Provider unavailable/);
});

test("stop during initialization never prompts a late-created session", async () => {
	const runtime = new SubagentRuntime();
	const f = fake();
	let release!: (session: ChildSession) => void;
	const id = runtime.spawn(input, () => new Promise((resolve) => { release = resolve; }));
	await tick();
	const stopped = runtime.stop(id);
	release(f.session);
	await stopped;
	assert.equal(f.sent.length, 0);
	assert.equal(runtime.get(id).status, "stopped");
	assert.ok(f.disposed);
});

test("branch restoration only uses its tool checkpoints and interrupts stale runs", async () => {
	const runtime = new SubagentRuntime();
	const id = runtime.spawn(input, async () => fake({ hold: true }).session);
	const details = runtime.snapshot();
	const entry = { type: "message", message: { role: "toolResult", toolName: "pi_subagent", isError: false, details } } as SessionEntry;
	await tick();
	await runtime.shutdown();
	await runtime.restore([entry]);
	assert.equal(runtime.get(id).status, "stopped");
	assert.equal(details.children[0]!.status, "running", "restore must not mutate durable entries");
	await runtime.restore([]);
	assert.equal(runtime.snapshot().children.length, 0);
	assert.throws(() => runtime.get(id), /Unknown/);
});

test("startup timeout settles promptly and disposes late arrivals", async () => {
	const runtime = new SubagentRuntime();
	const f = fake();
	let release!: (session: ChildSession) => void;
	const id = runtime.spawn({ ...input, timeoutMs: 10 }, () => new Promise((resolve) => { release = resolve; }));
	await runtime.wait([id], 200);
	assert.equal(runtime.get(id).status, "stopped");
	release(f.session);
	await tick();
	assert.ok(f.disposed);
	assert.equal(f.sent.length, 0);
});

test("dispose failures are visible and do not leak capacity", async () => {
	const runtime = new SubagentRuntime();
	const id = runtime.spawn(input, async () => fake({ disposeError: true }).session);
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "failed");
	assert.match(runtime.get(id).error!, /Cleanup failed/);
	await runtime.shutdown();
});

test("send at the idle transition starts a new turn instead of losing the message", async () => {
	const runtime = new SubagentRuntime();
	const f = fake({ hold: true });
	const id = runtime.spawn(input, async () => f.session);
	await tick();
	Object.defineProperty(f.session, "isStreaming", { value: false });
	const next = fake();
	const send = runtime.send(id, "E2E_NEXT", async () => next.session);
	f.release();
	await send;
	await runtime.wait([id], 1000);
	assert.deepEqual(next.sent, ["E2E_NEXT"]);
	assert.equal(runtime.get(id).turn, 2);
});

test("cancelled pending factories retain capacity until their late sessions are disposed", async () => {
	const runtime = new SubagentRuntime();
	const releases: ((session: ChildSession) => void)[] = [];
	const ids = Array.from({ length: 4 }, () => runtime.spawn(input, () => new Promise((resolve) => releases.push(resolve))));
	await tick();
	await Promise.all(ids.map((id) => runtime.stop(id)));
	assert.throws(() => runtime.spawn(input, async () => fake().session), /Four/);
	const late = releases.map((release) => { const f = fake(); release(f.session); return f; });
	await tick();
	assert.ok(late.every((f) => f.disposed));
	const id = runtime.spawn(input, async () => fake().session);
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "completed");
});

test("stop preserves cleanup failures instead of reporting successful cancellation", async () => {
	const runtime = new SubagentRuntime();
	const id = runtime.spawn(input, async () => fake({ hold: true, disposeError: true }).session);
	await tick();
	await runtime.stop(id);
	assert.equal(runtime.get(id).status, "failed");
	assert.match(runtime.get(id).error!, /Stopped by parent/);
	assert.match(runtime.get(id).error!, /Cleanup failed/);
});

test("record and continuation bounds fail explicitly", async () => {
	const runtime = new SubagentRuntime();
	for (let i = 0; i < 32; i++) {
		const id = runtime.spawn(input, async () => fake().session);
		await runtime.wait([id], 1000);
	}
	assert.throws(() => runtime.spawn(input, async () => fake().session), /32 subagents/);
	const other = new SubagentRuntime();
	const f = fake();
	f.session.messages.push({ role: "user", content: "x".repeat(2_000_001), timestamp: 0 });
	const id = other.spawn(input, async () => f.session);
	await other.wait([id], 1000);
	assert.equal(other.get(id).resumable, false);
	assert.deepEqual(other.get(id).history, []);
	await assert.rejects(other.send(id, "again", async () => fake().session), /checkpoint limit/);
});
