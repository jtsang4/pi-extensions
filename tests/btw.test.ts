import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SessionManager,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import btwExtension from "../extensions/btw/index.ts";
import { BtwRuntime, type SideSessionFactory } from "../extensions/btw/runtime.ts";
import {
	BTW_STATE_ENTRY_TYPE,
	BTW_STATE_VERSION,
	applyBtwEvent,
	createBtwState,
	reduceBtwState,
	type BtwStateEvent,
	type BtwThread,
} from "../extensions/btw/state.ts";
import { BtwConversationOverlay, buildThreadTranscript, createThreadPicker } from "../extensions/btw/ui.ts";

function assistant(text: string, stopReason: "stop" | "aborted" | "error" = "stop") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		provider: "test",
		model: "test-model",
		api: "openai-responses" as const,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "error" ? { errorMessage: "E2E side failure" } : {}),
		timestamp: Date.now(),
	};
}

function customEntry(id: string, parentId: string | null, data: BtwStateEvent): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date(data.at).toISOString(),
		customType: BTW_STATE_ENTRY_TYPE,
		data,
	};
}

function createdEvent(at = 1): BtwStateEvent {
	return {
		version: BTW_STATE_VERSION,
		kind: "thread_created",
		at,
		thread: {
			id: "thread-1",
			title: "First question",
			createdAt: at,
			updatedAt: at,
			model: { provider: "test", id: "test-model", api: "openai-responses" },
			thinkingLevel: "off",
			seedEntries: [],
		},
	};
}

test("BTW state is branch-sensitive and normalizes unfinished turns on restore", () => {
	const create = createdEvent();
	const queue: BtwStateEvent = {
		version: BTW_STATE_VERSION,
		kind: "turn_queued",
		at: 2,
		threadId: "thread-1",
		turn: { id: "turn-1", prompt: "Question", createdAt: 2, updatedAt: 2 },
	};
	const start: BtwStateEvent = {
		version: BTW_STATE_VERSION,
		kind: "turn_started",
		at: 3,
		threadId: "thread-1",
		turnId: "turn-1",
	};
	const branch = [customEntry("a", null, create), customEntry("b", "a", queue), customEntry("c", "b", start)];
	const restored = reduceBtwState(branch);
	assert.equal(restored.threads.get("thread-1")?.status, "interrupted");
	assert.equal(restored.threads.get("thread-1")?.turns[0]?.reason, "Pi stopped before this BTW turn finished.");

	const rewound = reduceBtwState(branch.slice(0, 1));
	assert.equal(rewound.threads.get("thread-1")?.status, "idle");
	assert.equal(rewound.threads.get("thread-1")?.turns.length, 0);

	const live = createBtwState();
	applyBtwEvent(live, create);
	applyBtwEvent(live, queue);
	assert.equal(live.threads.get("thread-1")?.status, "queued");
});

test("BTW restore skips malformed persisted events", () => {
	const malformed = {
		type: "custom",
		id: "bad",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: BTW_STATE_ENTRY_TYPE,
		data: { version: BTW_STATE_VERSION, kind: "thread_created", at: 1 },
	} as SessionEntry;
	const malformedEntry = customEntry("entry", "created", {
		version: BTW_STATE_VERSION,
		kind: "entry_appended",
		at: 2,
		threadId: "thread-1",
		entry: {
			type: "compaction",
			id: "broken",
			parentId: null,
			timestamp: new Date().toISOString(),
		} as SessionEntry,
	});
	assert.doesNotThrow(() => reduceBtwState([malformed]));
	assert.equal(reduceBtwState([malformed]).threads.size, 0);
	const danglingCompaction = customEntry("dangling", "created", {
		version: BTW_STATE_VERSION,
		kind: "entry_appended",
		at: 3,
		threadId: "thread-1",
		entry: {
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "summary",
			firstKeptEntryId: "missing",
			tokensBefore: 100,
		},
	});
	const restored = reduceBtwState([customEntry("created", null, createdEvent()), malformedEntry, danglingCompaction]);
	assert.equal(restored.threads.get("thread-1")?.entries.length, 0);
});

type FakeControl = {
	threadId: string;
	prompt: string;
	release: () => void;
	aborted: boolean;
	handoffTool: Parameters<SideSessionFactory>[0]["handoffTool"];
};

function createHarness(options: { compact?: boolean; stopReason?: "stop" | "error"; main?: SessionManager } = {}) {
	const main = options.main ?? SessionManager.inMemory(process.cwd());
	const sentMessages: Array<{ message: any; options: any }> = [];
	const controls: FakeControl[] = [];
	const starts: string[] = [];
	let running = 0;
	let maxRunning = 0;
	let idle = true;
	let id = 0;
	let now = 100;

	const pi = {
		appendEntry(customType: string, data: unknown) {
			main.appendCustomEntry(customType, structuredClone(data));
		},
		getAllTools() {
			return ["read", "bash", "edit", "write", "grep", "find", "ls", "other"].map((name) => ({
				name,
				description: name,
				parameters: {},
				promptGuidelines: [],
				sourceInfo: { source: name === "other" ? "extension" : "builtin" },
			}));
		},
		getThinkingLevel: () => "off",
		sendMessage(message: unknown, sendOptions: unknown) {
			sentMessages.push({ message, options: sendOptions });
		},
	} as unknown as ExtensionAPI;

	const factory: SideSessionFactory = async ({ thread, sessionManager, handoffTool }) => {
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		let release!: () => void;
		let waiting: Promise<void> | undefined;
		let aborted = false;
		const session = {
			sessionManager,
			get messages() {
				return sessionManager.buildSessionContext().messages;
			},
			subscribe(listener: (event: AgentSessionEvent) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async prompt(prompt: string) {
				running++;
				maxRunning = Math.max(maxRunning, running);
				starts.push(thread.id);
				const user = { role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() };
				sessionManager.appendMessage(user);
				for (const listener of listeners) listener({ type: "message_end", message: user });
				waiting = new Promise<void>((resolve) => {
					release = resolve;
				});
				const control: FakeControl = {
					threadId: thread.id,
					prompt,
					release,
					aborted,
					handoffTool,
				};
				controls.push(control);
				await waiting;
				const response = assistant(aborted ? "" : `answer:${prompt}`, aborted ? "aborted" : (options.stopReason ?? "stop"));
				sessionManager.appendMessage(response);
				if (options.compact && !aborted) {
					const first = [...sessionManager.getEntries()].reverse().find(
						(entry) => entry.type === "message" && entry.message.role === "user",
					)!;
					sessionManager.appendCompaction("compact summary", first.id, 100);
				}
				for (const listener of listeners) listener({ type: "message_end", message: response });
				running--;
			},
			async abort() {
				aborted = true;
				const control = controls.at(-1);
				if (control) control.aborted = true;
				release?.();
				await waiting;
			},
			dispose() {
				listeners.clear();
			},
		};
		return session as any;
	};

	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "test-model", api: "openai-responses" },
		thinkingLevel: "off",
		sessionManager: main,
		modelRegistry: {},
		isIdle: () => idle,
		ui: { notify() {}, setStatus() {} },
	} as unknown as ExtensionCommandContext;
	const runtime = new BtwRuntime(pi, {
		createSession: factory,
		createId: () => `id-${++id}`,
		now: () => ++now,
	});
	runtime.restore(main.getBranch());

	return {
		ctx,
		main,
		runtime,
		controls,
		starts,
		sentMessages,
		get maxRunning() {
			return maxRunning;
		},
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for BTW state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("BTW created before any Main reply initializes persistent session storage", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-btw-session-"));
	try {
		const main = SessionManager.create(process.cwd(), sessionDir);
		const harness = createHarness({ main });
		harness.runtime.createThread("persist first", harness.ctx);
		assert.ok(main.getSessionFile());
		assert.equal(existsSync(main.getSessionFile()!), true);
		await harness.runtime.suspend("test cleanup");
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("BTW runtime executes turns through a single-concurrency FIFO queue and persists complete entries", async () => {
	const harness = createHarness();
	const first = harness.runtime.createThread("first", harness.ctx);
	const second = harness.runtime.createThread("second", harness.ctx);
	await waitFor(() => harness.controls.length === 1);
	await waitFor(() => harness.runtime.getThread(first.id)?.entries.some((entry) => entry.type === "message") === true);
	assert.deepEqual(harness.starts, [first.id]);
	assert.equal(harness.runtime.getThread(second.id)?.status, "queued");

	harness.controls[0]!.release();
	await waitFor(() => harness.controls.length === 2);
	assert.deepEqual(harness.starts, [first.id, second.id]);
	assert.equal(harness.runtime.getThread(first.id)?.status, "idle");
	harness.controls[1]!.release();
	await waitFor(() => harness.runtime.getThread(second.id)?.status === "idle");
	assert.equal(harness.maxRunning, 1);
	assert.deepEqual(
		harness.runtime.getThread(first.id)?.entries.filter((entry) => entry.type === "message").map((entry) =>
			entry.type === "message" ? entry.message.role : "",
		),
		["user", "assistant"],
	);
	assert.ok(harness.main.getBranch().some((entry) => entry.type === "custom" && entry.customType === BTW_STATE_ENTRY_TYPE));
});

test("BTW runtime pauses queued turns and interrupts the active turn on lifecycle suspension", async () => {
	const harness = createHarness();
	const first = harness.runtime.createThread("first", harness.ctx);
	const second = harness.runtime.createThread("second", harness.ctx);
	await waitFor(() => harness.controls.length === 1);
	await harness.runtime.suspend("tree navigation");
	assert.equal(harness.runtime.getThread(first.id)?.status, "interrupted");
	assert.equal(harness.runtime.getThread(second.id)?.status, "paused");
	assert.deepEqual(harness.starts, [first.id]);
});

test("restored paused turns require explicit resume", async () => {
	const harness = createHarness();
	const first = harness.runtime.createThread("first", harness.ctx);
	const second = harness.runtime.createThread("second", harness.ctx);
	await waitFor(() => harness.controls.length === 1);
	await harness.runtime.suspend("reload");

	const restored = createHarness();
	for (const entry of harness.main.getBranch()) {
		if (entry.type === "custom") restored.main.appendCustomEntry(entry.customType, structuredClone(entry.data));
	}
	restored.runtime.restore(restored.main.getBranch());
	assert.equal(restored.runtime.getThread(second.id)?.status, "paused");
	assert.equal(restored.starts.length, 0);
	assert.equal(restored.runtime.resumePaused(second.id, restored.ctx), 1);
	await waitFor(() => restored.controls.length === 1);
	assert.deepEqual(restored.starts, [second.id]);
	restored.controls[0]!.release();
	await waitFor(() => restored.runtime.getThread(second.id)?.status === "idle");
	assert.equal(restored.runtime.getThread(first.id)?.status, "interrupted");
});

test("BTW compaction references survive persistence and rematerialization", async () => {
	const harness = createHarness({ compact: true });
	const thread = harness.runtime.createThread("first", harness.ctx);
	await waitFor(() => harness.controls.length === 1);
	harness.controls[0]!.release();
	await waitFor(() => harness.runtime.getThread(thread.id)?.status === "idle");
	assert.ok(harness.runtime.getThread(thread.id)?.entries.some((entry) => entry.type === "compaction"));

	harness.runtime.enqueueFollowUp(thread.id, "second", harness.ctx);
	await waitFor(() => harness.controls.length === 2);
	harness.controls[1]!.release();
	await waitFor(() => harness.runtime.getThread(thread.id)?.turns.at(-1)?.status === "completed");
});

test("an error assistant remains interrupted when compaction shrinks the active context", async () => {
	const harness = createHarness({ compact: true, stopReason: "error" });
	for (let index = 0; index < 6; index++) {
		harness.main.appendMessage({
			role: "user",
			content: [{ type: "text", text: `seed-${index}` }],
			timestamp: Date.now(),
		});
		harness.main.appendMessage(assistant(`seed-answer-${index}`));
	}
	const thread = harness.runtime.createThread("fail after compaction", harness.ctx);
	await waitFor(() => harness.controls.length === 1);
	harness.controls[0]!.release();
	await waitFor(() => harness.runtime.getThread(thread.id)?.status === "interrupted");
	assert.equal(harness.runtime.getThread(thread.id)?.turns.at(-1)?.reason, "E2E side failure");
});

test("btw_handoff actively delivers to idle or busy Main Sessions without clearing the thread", async () => {
	const harness = createHarness();
	const thread = harness.runtime.createThread("handoff", harness.ctx);
	await waitFor(() => harness.controls.length === 1);
	const tool = harness.controls[0]!.handoffTool as any;
	await tool.execute("call-idle", { content: "selected", instruction: "use it" }, undefined, undefined, {});
	assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: true });
	assert.match(harness.sentMessages[0]?.message.content, /selected/);

	harness.setIdle(false);
	await tool.execute("call-busy", { content: "more", instruction: "apply it" }, undefined, undefined, {});
	assert.deepEqual(harness.sentMessages[1]?.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.ok(harness.runtime.getThread(thread.id));
	harness.controls[0]!.release();
	await waitFor(() => harness.runtime.getThread(thread.id)?.status === "idle");
});

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as any;

test("BTW picker shortcuts support Kitty keyboard encoding", () => {
	const thread = (() => {
		const state = createBtwState();
		applyBtwEvent(state, createdEvent());
		return state.threads.get("thread-1")!;
	})();
	let result: unknown;
	const picker = createThreadPicker(
		{ requestRender() {} } as any,
		theme,
		{} as any,
		[thread],
		(value) => {
			result = value;
		},
	);
	picker.handleInput?.("\x1b[114u");
	assert.deepEqual(result, { action: "resume", threadId: thread.id });
});

function transcriptThread(): BtwThread {
	const state = createBtwState();
	applyBtwEvent(state, createdEvent());
	const thread = state.threads.get("thread-1")!;
	thread.entries.push(
		{
			type: "message",
			id: "u",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "inspect" }], timestamp: Date.now() },
		},
		{
			type: "message",
			id: "a",
			parentId: "u",
			timestamp: new Date().toISOString(),
			message: {
				...assistant("done"),
				content: [
					{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.ts" } },
					{ type: "text", text: "done" },
				],
			},
		},
		{
			type: "message",
			id: "r",
			parentId: "a",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(5_000) }],
				isError: false,
				timestamp: Date.now(),
			},
		},
	);
	return thread;
}

test("BTW transcript collapses tool output by default and avoids incrementally persisted live duplicates", () => {
	const thread = transcriptThread();
	const collapsed = buildThreadTranscript(thread, undefined, false, theme, 50).join("\n");
	assert.match(collapsed, /Tool read/);
	assert.doesNotMatch(collapsed, /x{100}/);
	const expandedLines = buildThreadTranscript(thread, undefined, true, theme, 50);
	assert.match(expandedLines.join("\n"), /tool output truncated for display/);
	assert.ok(expandedLines.every((line) => visibleWidth(line) <= 50));

	const user = thread.entries.find((entry) => entry.type === "message" && entry.message.role === "user")!;
	const response = thread.entries.find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
	assert.equal(user.type, "message");
	assert.equal(response.type, "message");
	const live = buildThreadTranscript(
		thread,
		{
			threadId: thread.id,
			prompt: "inspect",
			user: user.message,
			assistant: response.message,
			tools: [{ id: "call", name: "read", args: { path: "file.ts" }, result: { content: [] }, running: false }],
		},
		false,
		theme,
		50,
	).join("\n");
	assert.equal(live.match(/\bYou\b/g)?.length, 1);
	assert.equal(live.match(/Tool read/g)?.length, 1);
});

test("extension input fallback keeps visible-overlay prompts out of the Main Session", async () => {
	const main = SessionManager.inMemory(process.cwd());
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi = {
		appendEntry(customType: string, data: unknown) {
			main.appendCustomEntry(customType, structuredClone(data));
		},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		registerMessageRenderer() {},
		on(event: string, handler: unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	btwExtension(pi);
	const handle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "test-model", api: "openai-responses" },
		thinkingLevel: "off",
		sessionManager: main,
		modelRegistry: { find: () => undefined },
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: {
			notify() {},
			setStatus() {},
			custom(factory: any) {
				return new Promise<void>((resolve) => {
					factory({ requestRender() {}, showOverlay: () => handle }, theme, { matches: () => false }, resolve);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	await commands.get("btw").handler("initial", ctx);
	const result = await handlers.get("input")({ type: "input", text: "fallback follow-up", source: "interactive" });
	assert.deepEqual(result, { action: "handled" });
	assert.ok(
		main.getBranch().some(
			(entry) =>
				entry.type === "custom" &&
				(entry.data as BtwStateEvent).kind === "turn_queued" &&
				(entry.data as Extract<BtwStateEvent, { kind: "turn_queued" }>).turn.prompt === "fallback follow-up",
		),
	);
	await handlers.get("session_shutdown")({}, ctx);
});

test("Escape hides a BTW overlay without cancelling; /cancel cancels a running turn", () => {
	const thread = transcriptThread();
	thread.status = "running";
	let hidden = 0;
	let cancelled = 0;
	const submitted: string[] = [];
	const tui = { requestRender() {} } as any;
	const keybindings = {
		matches(data: string, action: string) {
			return data === "\u001b" && action === "tui.select.cancel";
		},
	} as any;
	const overlay = new BtwConversationOverlay(
		tui,
		theme,
		keybindings,
		thread.id,
		() => thread,
		() => undefined,
		(_id, prompt) => submitted.push(prompt),
		() => hidden++,
		() => cancelled++,
		() => {},
	);
	overlay.handleInput("\u001b");
	assert.equal(hidden, 1);
	assert.equal(cancelled, 0);
	for (const character of "/cancel") overlay.handleInput(character);
	overlay.handleInput("\r");
	assert.equal(cancelled, 1);
	overlay.handleInput("\x1b[200~alpha\nbeta\x1b[201~");
	overlay.handleInput("\r");
	assert.deepEqual(submitted, ["alpha beta"]);
	assert.ok(overlay.render(79).every((line) => visibleWidth(line) <= 79));
});
