import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SubagentRuntime, type ChildSession, type History } from "../extensions/subagent/runtime.ts";

const input = { task: "AUDIT_TASK", role: "scout" as const, model: { provider: "test", id: "test" }, thinking: "off", tools: ["read"], timeoutMs: 1000, maxTurns: 3 };
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason }) as History[number];
function scripted(script: History, failure?: string): ChildSession {
	const messages: History = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	return {
		messages, isStreaming: false,
		async prompt() {
			for (const message of script) {
				messages.push(message);
				for (const listener of listeners) listener({ type: "message_end", message });
			}
			if (failure) throw new Error(failure);
		},
		async steer() {}, async abort() {}, dispose() {},
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

test("audit: empty terminal messages preserve useful output without hiding failed stop reasons", async () => {
	for (const reason of ["stop", "length", "error"]) {
		const runtime = new SubagentRuntime();
		const id = runtime.spawn(input, async () => scripted([assistant("AUDIT_USEFUL", "toolUse"), assistant("", reason)]));
		await runtime.wait([id], 1000);
		assert.equal(runtime.get(id).output, "AUDIT_USEFUL");
		assert.equal(runtime.get(id).status, reason === "stop" ? "completed" : "failed");
	}
});

test("audit: prompt failure retains the last useful partial report", async () => {
	const runtime = new SubagentRuntime();
	const id = runtime.spawn(input, async () => scripted([assistant("AUDIT_PARTIAL", "toolUse")], "AUDIT_PROVIDER_DISCONNECTED"));
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "failed");
	assert.equal(runtime.get(id).output, "AUDIT_PARTIAL");
	assert.match(runtime.get(id).error!, /AUDIT_PROVIDER_DISCONNECTED/);
});

test("audit: an entirely empty response is not a verified task report", async () => {
	const runtime = new SubagentRuntime();
	const id = runtime.spawn(input, async () => scripted([assistant("")]));
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "failed");
	assert.match(runtime.get(id).error!, /without a textual report/);
});

test("audit: wait-any collects an early result without cancelling slow children", async () => {
	const runtime = new SubagentRuntime();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const slow = scripted([assistant("SLOW_DONE")]);
	const prompt = slow.prompt.bind(slow);
	slow.prompt = async (...args) => { await gate; await prompt(...args); };
	slow.abort = async () => { release(); };
	const slowId = runtime.spawn(input, async () => slow);
	const fastId = runtime.spawn(input, async () => scripted([assistant("FAST_DONE")]));
	try {
		const started = Date.now();
		await runtime.wait([slowId, fastId], 700, undefined, "any");
		assert.ok(Date.now() - started < 500, "wait-any must not wait until the all-children timeout");
		assert.equal(runtime.get(fastId).status, "completed");
		assert.equal(runtime.get(slowId).status, "running");
		const cancelled = new AbortController();
		cancelled.abort();
		await assert.rejects(runtime.wait([slowId], 700, cancelled.signal, "any"), /cancelled/);
		assert.equal(runtime.get(slowId).status, "running");
	} finally { await runtime.shutdown(); }
});

test("audit: forgetting a terminal record frees capacity without affecting an older branch", async () => {
	const runtime = new SubagentRuntime();
	for (let i = 0; i < 32; i++) {
		const id = runtime.spawn(input, async () => scripted([assistant("DONE")]));
		await runtime.wait([id], 1000);
	}
	const old = runtime.snapshot();
	const removed = old.children[0]!.id;
	runtime.forget(removed);
	assert.throws(() => runtime.get(removed), /Unknown/);
	assert.equal(old.children.length, 32);
	const newId = runtime.spawn(input, async () => scripted([assistant("FRESH")]));
	assert.throws(() => runtime.forget(newId), /cleanup/);
	await runtime.wait([newId], 1000);
	assert.equal(runtime.snapshot().children.length, 32);
	assert.notEqual(newId, removed);
});

test("audit: activity reports per-turn model usage and identifies follow-up work", async () => {
	const message = { ...assistant("PROGRESS") } as Extract<History[number], { role: "assistant" }>;
	message.usage = { input: 10, output: 3, cacheRead: 4, cacheWrite: 2, totalTokens: 19, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
	const runtime = new SubagentRuntime();
	const id = runtime.spawn(input, async () => scripted([message, message]));
	await runtime.wait([id], 1000);
	const activity = runtime.get(id).activity!;
	assert.equal(activity.modelTurns, 2);
	assert.deepEqual(activity.usage, { input: 20, output: 6, cacheRead: 8, cacheWrite: 4, totalTokens: 38, cost: 20 });
	assert.ok(activity.finishedAt! >= activity.startedAt);
	await runtime.send(id, "AUDIT_FOLLOWUP", async () => scripted([message]));
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).task, "AUDIT_FOLLOWUP");
	assert.equal(runtime.get(id).activity!.modelTurns, 1);
});

test("audit: a terminal session cannot silently drop messages left in its queue", async () => {
	const runtime = new SubagentRuntime();
	const childSession = scripted([assistant("FINISHED_FIRST_TASK")]);
	let emit!: (event: AgentSessionEvent) => void;
	const subscribe = childSession.subscribe.bind(childSession);
	childSession.subscribe = (listener) => { emit = listener; return subscribe(listener); };
	const prompt = childSession.prompt.bind(childSession);
	childSession.prompt = async (...args) => {
		emit({ type: "queue_update", steering: ["PENDING_TASK"], followUp: [] });
		await prompt(...args);
	};
	const id = runtime.spawn(input, async () => childSession);
	await runtime.wait([id], 1000);
	assert.equal(runtime.get(id).status, "failed");
	assert.match(runtime.get(id).error!, /1 queued message.*not delivered/);
});

test("audit: cancelling a send during the idle transition never starts its delayed follow-up", async () => {
	const runtime = new SubagentRuntime();
	const childSession = scripted([assistant("FIRST_DONE")]);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const prompt = childSession.prompt.bind(childSession);
	childSession.prompt = async (...args) => { await gate; await prompt(...args); };
	const id = runtime.spawn(input, async () => childSession);
	await new Promise((resolve) => setImmediate(resolve));
	const controller = new AbortController();
	let followup = false;
	const sent = runtime.send(id, "MUST_NOT_RUN", async () => { followup = true; return scripted([assistant("WRONG")]); }, controller.signal);
	const rejected = assert.rejects(sent, /message was not delivered/);
	controller.abort();
	release();
	await rejected;
	await runtime.wait([id], 1000);
	assert.equal(followup, false);
	assert.equal(runtime.get(id).turn, 1);
	assert.equal(runtime.get(id).status, "completed");
});
