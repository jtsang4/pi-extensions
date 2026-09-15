import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import betterCompactionExtension, { createSessionBeforeCompactHandler, type CompleteFn } from "../archives/better-compaction/index.ts";
import {
	buildCheckpointInstruction,
	buildSummaryMessages,
	CHECKPOINT_SECTIONS,
	dropOrphanToolResults,
	extractSummaryText,
	mergeFileLists,
	PRUNE_HEAD_CHARS,
	PRUNE_MARKER,
	PRUNE_TAIL_CHARS,
	PRUNE_THRESHOLD_CHARS,
	pruneToolResults,
	shouldYieldToRemoteCompaction,
	summaryPassesShrink,
} from "../archives/better-compaction/pipeline.ts";

// ---------- helpers ----------

function fakeModel(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "glm-5.3",
		name: "GLM",
		api: "anthropic-messages",
		provider: "zai-coding-cn",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	} as Model<any>;
}

const USAGE: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantWithText(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "zai-coding-cn",
		model: "glm-5.3",
		usage: USAGE,
		stopReason,
		timestamp: 0,
	};
}

function textResult(text: string): Message {
	return { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function textLengthOf(message: Message): number {
	if (typeof message.content === "string") return message.content.length;
	return message.content.reduce((n, b) => (b.type === "text" ? n + b.text.length : n), 0);
}

function preparation(overrides: Record<string, unknown> = {}) {
	const chunkyToolOutput = "L".repeat(16_000); // ≈ 4k tokens: pushes the span above the shrink-validation floor
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			{ role: "user", content: "fix the login bug. The bug is in the session refresh path: tokens expire after 10 minutes but the client never retries. Reproduce by logging in, waiting 11 minutes, then refreshing the page.", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will fix it. Reading the session refresh code first." },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "auth/session.ts" } },
				],
				api: "anthropic-messages",
				provider: "zai-coding-cn",
				model: "glm-5.3",
				usage: USAGE,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: `auth/session.ts (lines 1-400)\n${chunkyToolOutput}\n// refresh() never retries on 401` }], isError: false, timestamp: 3 },
		] as never,
		turnPrefixMessages: [] as never[],
		isSplitTurn: false,
		tokensBefore: 50000,
		fileOps: { read: new Set<string>(["login.ts"]), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		...overrides,
	};
}

function fakeContext(model: Model<any> | undefined, overrides: Record<string, unknown> = {}) {
	const notifications: string[] = [];
	return {
		model,
		hasUI: true,
		ui: { notify: (msg: string) => notifications.push(msg) },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test", headers: { "x-h": "1" }, env: {} }) },
		getSystemPrompt: () => "SYSTEM PROMPT",
		notifications,
		...overrides,
	};
}

function event(prep = preparation(), overrides: Record<string, unknown> = {}) {
	return { preparation: prep, branchEntries: [], signal: new AbortController().signal, reason: "threshold" as const, willRetry: false, ...overrides };
}

/** Scripted fake LLM: records each call, returns queued responses or throws. */
function scriptedComplete(script: (AssistantMessage | Error)[]) {
	const calls: { model: Model<any>; context: Context; options: Record<string, unknown> }[] = [];
	const fn: CompleteFn = async (model, context, options) => {
		calls.push({ model, context, options: options ?? {} });
		const next = script.shift();
		if (next instanceof Error) throw next;
		if (!next) throw new Error("script exhausted");
		return next;
	};
	return { fn, calls };
}

// ---------- pruneToolResults ----------

test("prune rewrites oversized tool results to head + marker + tail", () => {
	const big = "x".repeat(PRUNE_THRESHOLD_CHARS + 5000);
	const { messages, prunedCount } = pruneToolResults([userMessage("hi"), textResult(big)]);
	assert.equal(prunedCount, 1);
	const pruned = messages[1];
	assert.ok(textLengthOf(pruned) <= PRUNE_THRESHOLD_CHARS);
	const text = (pruned.content as { type: "text"; text: string }[]).find((b) => b.type === "text")!.text;
	assert.ok(text.startsWith("x".repeat(PRUNE_HEAD_CHARS)));
	assert.ok(text.includes(PRUNE_MARKER));
	assert.ok(text.endsWith("x".repeat(PRUNE_TAIL_CHARS)));
	assert.ok(text.length < big.length);
	assert.deepEqual(messages[0], userMessage("hi"));
});

test("prune is idempotent: a second pass changes nothing", () => {
	const big = textResult("y".repeat(PRUNE_THRESHOLD_CHARS * 3));
	const first = pruneToolResults([big]);
	assert.equal(first.prunedCount, 1);
	const second = pruneToolResults(first.messages);
	assert.equal(second.prunedCount, 0);
	assert.deepEqual(second.messages, first.messages);
});

test("prune leaves small tool results and non-text blocks alone", () => {
	const small = textResult("tiny");
	assert.deepEqual(pruneToolResults([small]), { messages: [small], prunedCount: 0 });
	const imageBig: Message = {
		...textResult("z".repeat(PRUNE_THRESHOLD_CHARS + 100)),
		content: [
			{ type: "image", data: "AAAA", mimeType: "image/png" } as never,
			{ type: "text", text: "z".repeat(PRUNE_THRESHOLD_CHARS + 100) },
		],
	};
	const { messages, prunedCount } = pruneToolResults([imageBig]);
	assert.equal(prunedCount, 1);
	assert.ok((messages[0].content as { type: string }[]).some((b) => b.type === "image"));
});

test("prune does not split UTF-16 surrogate pairs at boundaries", () => {
	const big = "a".repeat(PRUNE_HEAD_CHARS - 1) + "😀" + "b".repeat(5000);
	const { messages } = pruneToolResults([textResult(big)]);
	const text = (messages[0].content as { type: "text"; text: string }[]).find((b) => b.type === "text")!.text;
	const units = [...text].map((ch) => ch.charCodeAt(0));
	for (let i = 0; i < units.length; i++) {
		const isHigh = units[i] >= 0xd800 && units[i] <= 0xdbff;
		const isLow = units[i] >= 0xdc00 && units[i] <= 0xdfff;
		assert.ok(!(isHigh || isLow) || (isHigh && units[i + 1] >= 0xdc00) || (isLow && units[i - 1] <= 0xdbff), `lone surrogate at ${i}`);
	}
});

test("prune rejects misconfigured budgets", () => {
	assert.throws(() => pruneToolResults([], 100, 90, 50));
});

test("dropOrphanToolResults removes tool results whose call is outside the span", () => {
	const assistantWithCall: Message = {
		role: "assistant",
		content: [
			{ type: "text", text: "reading" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
		],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};
	const paired = { ...textResult("ok"), toolCallId: "call-1" };
	const orphan = textResult("orphan");
	const messages = [assistantWithCall, paired, orphan];
	assert.deepEqual(dropOrphanToolResults(messages), [assistantWithCall, paired]);
	// No assistant calls at all: all tool results are orphans.
	assert.deepEqual(dropOrphanToolResults([userMessage("hi"), textResult("x")]), [userMessage("hi")]);
});

// ---------- guard ----------

test("guard yields only for OpenAI Responses-family models", () => {
	assert.equal(shouldYieldToRemoteCompaction(fakeModel({ provider: "openai", api: "openai-responses" })), true);
	assert.equal(shouldYieldToRemoteCompaction(fakeModel({ provider: "openai-codex", api: "openai-codex-responses" })), true);
	assert.equal(shouldYieldToRemoteCompaction(fakeModel({ provider: "openai", api: "openai-completions" })), false);
	assert.equal(shouldYieldToRemoteCompaction(fakeModel({ provider: "zai-coding-cn" })), false);
	assert.equal(shouldYieldToRemoteCompaction(fakeModel({ provider: "kimi-coding" })), false);
	assert.equal(shouldYieldToRemoteCompaction(undefined), false);
});

// ---------- instruction ----------

test("instruction contains all 8 sections; merge/overflow/focus/retry lines are conditional", () => {
	const base = buildCheckpointInstruction({ reason: "threshold" });
	for (const section of CHECKPOINT_SECTIONS) assert.ok(base.includes(section), `missing ${section}`);
	assert.ok(base.includes("<read-files>"));
	assert.ok(!base.includes("PRIOR checkpoint"));
	assert.ok(!base.includes("overflowed"));
	assert.ok(buildCheckpointInstruction({ reason: "threshold", previousSummary: "old" }).includes("PRIOR checkpoint"));
	assert.ok(buildCheckpointInstruction({ reason: "overflow" }).includes("overflowed"));
	assert.ok(buildCheckpointInstruction({ reason: "manual", customInstructions: "focus on API changes" }).includes("focus on API changes"));
	assert.ok(buildCheckpointInstruction({ reason: "threshold", retry: 1 }).includes("attempt 1"));
});

// ---------- summary messages / validation / extract ----------

test("summary messages replay the conversation verbatim with the instruction last", () => {
	const convo = [userMessage("hello"), textResult("data")];
	const messages = buildSummaryMessages(convo, "INSTRUCTION");
	assert.equal(messages.length, 3);
	assert.deepEqual(messages.slice(0, 2), convo);
	const last = messages[2];
	assert.equal(last.role, "user");
	assert.ok(JSON.stringify(last.content).includes("INSTRUCTION"));
});

test("shrink validation rejects empty summaries and enforces shrinkage only above the floor", () => {
	assert.equal(summaryPassesShrink("", 1000), false);
	assert.equal(summaryPassesShrink("   \n  ", 1000), false);
	// Large source: a summary larger than the source must fail.
	assert.equal(summaryPassesShrink("x".repeat(4000 * 4), 2000), false);
	// Large source: shorter summary passes.
	assert.equal(summaryPassesShrink("short summary", 2000), true);
	// Small source (below the 2048 floor): the structured template may exceed
	// the span; validation must not reject it.
	assert.equal(summaryPassesShrink("x".repeat(4000), 125), true);
});

test("extractSummaryText joins text blocks and ignores thinking", () => {
	const assistant: AssistantMessage = {
		...assistantWithText(""),
		content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: " part one " }, { type: "text", text: "part two" }],
	};
	assert.equal(extractSummaryText(assistant), "part one\npart two");
});

// ---------- cumulative file tracking ----------

test("mergeFileLists merges prior lists and demotes later-modified files", () => {
	const fileOps = { read: new Set(["a.ts", "b.ts"]), written: new Set(["b.ts"]), edited: new Set<string>() };
	assert.deepEqual(mergeFileLists(fileOps, { readFiles: ["old.ts"], modifiedFiles: ["gone.ts"] }), {
		readFiles: ["a.ts", "old.ts"],
		modifiedFiles: ["b.ts", "gone.ts"],
	});
	assert.deepEqual(mergeFileLists(fileOps, undefined), { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
});

test("prior-details ownership boundary: foreign hook details are opaque, own engine's merge", async () => {
	const branch = (fromHook: boolean | undefined, details: unknown) => [
		{ type: "user", id: "u0", parentId: "h", timestamp: 0 },
		{ type: "compaction", id: "c0", parentId: "u0", timestamp: 1, summary: "old", firstKeptEntryId: "u0", tokensBefore: 1000, fromHook, details },
	];
	const mk = () => createSessionBeforeCompactHandler(scriptedComplete([assistantWithText("## Primary Request and Intent\n- checkpoint")]).fn);

	// Foreign hook-supplied details: not interpreted — current fileOps only.
	const foreign = await mk()(event(preparation(), { branchEntries: branch(true, { readFiles: ["secret.ts"] }) }), fakeContext(fakeModel()));
	assert.deepEqual(foreign?.compaction?.details?.readFiles, ["login.ts"], "foreign engine's file lists must not merge");

	// Own engine's marker on a hook entry: merged (chain continuity).
	const own = await mk()(
		event(preparation(), { branchEntries: branch(true, { engine: "jtsang4-better-compaction", readFiles: ["mine.ts"], modifiedFiles: [] }) }),
		fakeContext(fakeModel()),
	);
	assert.deepEqual(own?.compaction?.details?.readFiles, ["login.ts", "mine.ts"], "own engine's prior details merge");

	// pi-generated details (fromHook falsy): merged, like the default path.
	const piGen = await mk()(event(preparation(), { branchEntries: branch(false, { readFiles: ["pi.ts"] }) }), fakeContext(fakeModel()));
	assert.deepEqual(piGen?.compaction?.details?.readFiles, ["login.ts", "pi.ts"], "pi-generated prior details merge");
});

// ---------- handler: full injected pipeline ----------

test("handler yields on OpenAI Responses models and never calls the LLM", async () => {
	const { fn, calls } = scriptedComplete([assistantWithText("should not be called")]);
	const handler = createSessionBeforeCompactHandler(fn);
	const result = await handler(
		event(),
		fakeContext(fakeModel({ provider: "openai", api: "openai-responses" })),
	);
	assert.equal(result, undefined);
	assert.equal(calls.length, 0);
});

test("handler abstains without credentials", async () => {
	const { fn, calls } = scriptedComplete([]);
	const handler = createSessionBeforeCompactHandler(fn);
	const ctx = fakeContext(fakeModel(), {
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) },
	});
	assert.equal(await handler(event(), ctx), undefined);
	assert.equal(calls.length, 0);
	assert.equal(ctx.notifications.length, 0);
});

test("handler returns a marked compaction result: replay + prune + system prompt + cumulative files", async () => {
	const bigOutput = "L".repeat(PRUNE_THRESHOLD_CHARS + 4000);
	const prep = preparation({
		messagesToSummarize: [
			{ role: "user", content: "fix login", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading files" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "login.ts" } },
				],
				api: "anthropic-messages",
				provider: "zai-coding-cn",
				model: "glm-5.3",
				usage: USAGE,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: bigOutput }], isError: false, timestamp: 3 },
		],
	});
	const branchEntries = [
		{ type: "user", id: "u0", parentId: "h", timestamp: 0 },
		{ type: "compaction", id: "c0", parentId: "u0", timestamp: 1, summary: "old", firstKeptEntryId: "u0", tokensBefore: 1000, details: { readFiles: ["legacy.ts"], modifiedFiles: [] } },
	];
	const { fn, calls } = scriptedComplete([assistantWithText("## Primary Request and Intent\n- fix login\n...(checkpoint)")]);
	const handler = createSessionBeforeCompactHandler(fn);
	const result = await handler(event(prep, { branchEntries }), fakeContext(fakeModel()));

	assert.ok(result?.compaction, "returns compaction");
	const c = result.compaction;
	assert.equal(c.firstKeptEntryId, "kept-1");
	assert.equal(c.tokensBefore, 50000);
	assert.ok(c.summary.includes("fix login"));
	assert.deepEqual(c.usage, USAGE, "successful attempt's usage is persisted, not lost");

	// details: engine marker + cumulative files (prior legacy.ts + current login.ts) + pruned count
	assert.equal(c.details?.engine, "jtsang4-better-compaction");
	assert.deepEqual(c.details?.readFiles, ["legacy.ts", "login.ts"]);
	assert.equal(c.details?.prunedToolResults, 1);
	assert.equal(c.details?.attempts, 1);
	assert.deepEqual(c.details?.summarizer, { provider: "zai-coding-cn", model: "glm-5.3" });

	// the LLM call: system prompt replayed, oversized tool result pruned, instruction last
	assert.equal(calls.length, 1);
	assert.equal(calls[0].context.systemPrompt, "SYSTEM PROMPT");
	const sentMessages = calls[0].context.messages;
	const last = sentMessages[sentMessages.length - 1];
	assert.equal(last.role, "user");
	assert.ok(JSON.stringify(last.content).includes("compaction engine"));
	const prunedResult = sentMessages.find((m) => m.role === "toolResult")!;
	assert.ok(textLengthOf(prunedResult) <= PRUNE_THRESHOLD_CHARS, "oversized tool result was pruned in the replay");
	assert.ok(JSON.stringify(sentMessages).includes("[... tool result middle pruned ...]"));
	assert.equal(calls[0].options.apiKey, "sk-test");
	assert.equal(calls[0].options.cacheRetention, "short");
	assert.equal(calls[0].options.reasoning, "low"); // model.reasoning = true
	assert.equal(calls[0].options.maxTokens, 8192);
});

test("handler retries shrink failures with a tighter cap and retry instruction", async () => {
	const { fn, calls } = scriptedComplete([
		assistantWithText("x".repeat(999_999)), // fails shrink (longer than source)
		assistantWithText("## Primary Request and Intent\n- short checkpoint"),
	]);
	const handler = createSessionBeforeCompactHandler(fn);
	const ctx = fakeContext(fakeModel());
	const result = await handler(event(), ctx);

	assert.equal(result?.compaction?.details?.attempts, 2);
	assert.equal(calls.length, 2);
	assert.ok((calls[1].options.maxTokens as number) < (calls[0].options.maxTokens as number), "retry cap is halved");
	const firstInstruction = (calls[0].context.messages.at(-1)!.content as { text: string }[])[0].text;
	const secondInstruction = (calls[1].context.messages.at(-1)!.content as { text: string }[])[0].text;
	assert.ok(!firstInstruction.includes("attempt 1"));
	assert.ok(secondInstruction.includes("attempt 1"), "retry instruction tightened");
	assert.equal(ctx.notifications.length, 0, "no fallback notification on eventual success");
});

test("handler falls back to default compaction when both attempts fail shrink validation", async () => {
	const { fn, calls } = scriptedComplete([
		assistantWithText("x".repeat(999_999)),
		assistantWithText("y".repeat(999_999)),
	]);
	const handler = createSessionBeforeCompactHandler(fn);
	const ctx = fakeContext(fakeModel());
	assert.equal(await handler(event(), ctx), undefined);
	assert.equal(calls.length, 2);
	assert.equal(ctx.notifications.length, 1);
	assert.ok(ctx.notifications[0].includes("shrink"));
});

test("handler retries transient LLM errors once, then falls back with a notification", async () => {
	const { fn, calls } = scriptedComplete([
		new Error("socket terminated"),
		new Error("socket terminated"),
	]);
	const handler = createSessionBeforeCompactHandler(fn);
	const ctx = fakeContext(fakeModel());
	assert.equal(await handler(event(), ctx), undefined);
	assert.equal(calls.length, 2);
	assert.equal(ctx.notifications.length, 1);
	assert.ok(ctx.notifications[0].includes("socket terminated"));
});

test("handler retries stream stopReason=error once, then falls back", async () => {
	const { fn, calls } = scriptedComplete([
		assistantWithText("partial", "error"),
		assistantWithText("still error", "error"),
	]);
	const handler = createSessionBeforeCompactHandler(fn);
	assert.equal(await handler(event(), fakeContext(fakeModel())), undefined);
	assert.equal(calls.length, 2);
});

test("handler recovers when the first attempt errors and the second succeeds", async () => {
	const { fn, calls } = scriptedComplete([
		new Error("transient"),
		assistantWithText("## Primary Request and Intent\n- recovered checkpoint"),
	]);
	const handler = createSessionBeforeCompactHandler(fn);
	const result = await handler(event(), fakeContext(fakeModel()));
	assert.equal(result?.compaction?.details?.attempts, 2);
	assert.ok(result?.compaction?.summary.includes("recovered"));
	assert.equal(calls.length, 2);
});

test("handler treats abort as silent abstention: no calls after abort, no notification", async () => {
	const controller = new AbortController();
	const { fn, calls } = scriptedComplete([]);
	const handler = createSessionBeforeCompactHandler(fn);
	controller.abort();
	const result = await handler(event(preparation(), { signal: controller.signal }), fakeContext(fakeModel()));
	assert.equal(result, undefined);
	assert.equal(calls.length, 0);
});

test("handler passes customInstructions and reason=overflow into the instruction", async () => {
	const { fn, calls } = scriptedComplete([assistantWithText("## Primary Request and Intent\n- overflow checkpoint")]);
	const handler = createSessionBeforeCompactHandler(fn);
	await handler(
		event(preparation(), { reason: "overflow", customInstructions: "keep the DB schema details" }),
		fakeContext(fakeModel()),
	);
	const instruction = (calls[0].context.messages.at(-1)!.content as { text: string }[])[0].text;
	assert.ok(instruction.includes("overflowed"));
	assert.ok(instruction.includes("keep the DB schema details"));
});

test("handler includes the prior summary in the instruction when present", async () => {
	const { fn, calls } = scriptedComplete([assistantWithText("## Primary Request and Intent\n- merged checkpoint")]);
	const handler = createSessionBeforeCompactHandler(fn);
	const prep = preparation({ previousSummary: "PRIOR SUMMARY TEXT" });
	await handler(event(prep), fakeContext(fakeModel()));
	const instruction = (calls[0].context.messages.at(-1)!.content as { text: string }[])[0].text;
	assert.ok(instruction.includes("PRIOR checkpoint"));
});

// ---------- coexistence dispatch simulation ----------
// Mirrors pi's ExtensionRunner.emit() semantics, verified against its source:
// all handlers run in registration order; the LAST non-undefined result wins;
// handler errors are swallowed without stopping other handlers.

type TestEvent = ReturnType<typeof event>;
type TestContext = ReturnType<typeof fakeContext>;
type Handler = (ev: TestEvent, ctx: TestContext) => Promise<{ cancel?: boolean; compaction?: any } | undefined>;

async function simulatePiDispatch(handlers: Handler[], ev: TestEvent, ctx: TestContext) {
	let result: { cancel?: boolean; compaction?: any } | undefined;
	for (const handler of handlers) {
		try {
			const handlerResult = await handler(ev, ctx);
			if (handlerResult) result = handlerResult;
		} catch {
			// swallowed by the runner, like real pi
		}
	}
	return result;
}

/** Stub of pi-openai-server-compaction's abstain behavior (from its source, src/index.ts:205). */
const openAiServerCompactionStub: Handler = async (ev, ctx) => {
	const model = ctx.model;
	if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return undefined;
	return { compaction: { summary: "REMOTE", firstKeptEntryId: ev.preparation.firstKeptEntryId, tokensBefore: ev.preparation.tokensBefore, details: { engine: "algal-openai-server" } } };
};

function captureRegisteredHandler(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (name: string, h: Handler) => {
			assert.equal(name, "session_before_compact");
			assert.ok(!handler, "handler registered once");
			handler = h;
		},
	} as unknown as ExtensionAPI;
	betterCompactionExtension(pi);
	return handler!;
}

test("coexistence matrix: exactly one custom compactor wins per model family", async () => {
	const realHandler = captureRegisteredHandler();
	const cases = [
		{
			name: "openai + both extensions",
			model: fakeModel({ provider: "openai", api: "openai-responses" }),
			stub: openAiServerCompactionStub,
			wantEngine: "algal-openai-server",
		},
		{
			name: "openai + mine only (theirs absent)",
			model: fakeModel({ provider: "openai", api: "openai-responses" }),
			stub: undefined,
			wantEngine: undefined, // mine yields; pi default compaction runs
		},
		{
			name: "zai + both extensions",
			model: fakeModel({ provider: "zai-coding-cn" }),
			stub: openAiServerCompactionStub,
			wantEngine: "jtsang4-better-compaction",
		},
		{
			name: "zai + mine only",
			model: fakeModel({ provider: "zai-coding-cn" }),
			stub: undefined,
			wantEngine: "jtsang4-better-compaction",
		},
		{
			name: "zai + theirs throws (simulated crash)",
			model: fakeModel({ provider: "zai-coding-cn" }),
			stub: (async () => {
				throw new Error("stub boom");
			}) as Handler,
			wantEngine: "jtsang4-better-compaction",
		},
	];

	for (const c of cases) {
		// The real handler closes over the real complete(); for dispatch testing
		// route it through a handler with the same logic but a scripted LLM.
		const { fn } = scriptedComplete([assistantWithText("## Primary Request and Intent\n- dispatch checkpoint")]);
		const mine = createSessionBeforeCompactHandler(fn);
		const handlers = c.stub ? [mine, c.stub] : [mine];
		const result = await simulatePiDispatch(handlers as Handler[], event(), fakeContext(c.model));
		if (c.wantEngine) {
			assert.equal(result?.compaction?.details?.engine, c.wantEngine, c.name);
		} else {
			assert.equal(result, undefined, c.name); // yields → default compaction
		}
	}
	// The registered production handler must also abstain on openai models.
	assert.equal(await realHandler(event(), fakeContext(fakeModel({ provider: "openai", api: "openai-responses" }))), undefined);
});
