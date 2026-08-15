/**
 * Live smoke test for better-compaction (NOT part of `pnpm test` — real LLM call).
 *
 * Usage:
 *   node --experimental-strip-types tests/better-compaction.smoke.ts            # default: non-OpenAI model, better-compaction wins
 *   node --experimental-strip-types tests/better-compaction.smoke.ts openai     # OpenAI Responses model: better-compaction yields, openai-server-compaction wins
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

const REPO = new URL("..", import.meta.url).pathname;
const CWD = "/tmp/better-compaction-smoke";

rmSync(CWD, { recursive: true, force: true });
mkdirSync(`${CWD}/.pi`, { recursive: true });
writeFileSync(
	`${CWD}/.pi/settings.json`,
	JSON.stringify({ compaction: { keepRecentTokens: 100, reserveTokens: 4096 } }, null, 2),
);

// Seed facts the checkpoint must preserve (recall check).
const LAUNCH_CODE = "ZEPHYR-7741-XK";
const MAGIC_FILE = "src/orbital/telemetry.ts";

console.log("[smoke] creating real agent session (loads global packages incl. openai-server-compaction)...");
const loader = new DefaultResourceLoader({
	cwd: CWD,
	agentDir: `${process.env.HOME}/.pi/agent`,
	additionalExtensionPaths: [`${REPO}/extensions/better-compaction/index.ts`],
});
await loader.reload(); // required when passing a custom resourceLoader
const { session, extensionsResult } = await createAgentSession({ cwd: CWD, resourceLoader: loader });

const loadErrors = extensionsResult.errors ?? [];
console.log(`[smoke] extensions loaded: ${extensionsResult.extensions.length}, load errors: ${loadErrors.length}`);
for (const e of extensionsResult.extensions) console.log("[smoke] ext:", e.path);
for (const d of loadErrors) console.log("[smoke] LOAD ERROR:", JSON.stringify(d));

const sm = session.sessionManager;
const OPENAI_MODE = process.argv[2] === "openai";

// Pick a non-OpenAI model with configured auth so better-compaction takes the
// wheel (it yields to pi-openai-server-compaction on OpenAI Responses models).
const candidates = session.modelRuntime.getModels ? session.modelRuntime.getModels() : [];
const preferred = OPENAI_MODE
	? candidates.find((m: { provider: string; id: string }) => m.provider === "openai-codex")
	: candidates.find((m: { provider: string; id: string }) => m.provider === "zai-coding-cn" && m.id === "glm-5.3");
const fallback = OPENAI_MODE
	? candidates.find((m: { provider: string }) => m.provider === "openai-codex" || m.provider === "openai")
	: candidates.find(
			(m: { provider: string; api: string }) => m.provider !== "openai" && m.provider !== "openai-codex" && session.modelRuntime.hasConfiguredAuth(m.provider) && !String(m.api).includes("responses"),
		);
const chosen = preferred ?? fallback ?? session.model;
if (chosen && session.model?.id !== chosen.id) await session.setModel(chosen);
console.log(`[smoke] model: ${session.model?.provider}/${session.model?.id ?? "?"} (candidates: ${candidates.length})`);
sm.appendMessage({ role: "user", content: `We are hardening the satellite telemetry service. The launch code is ${LAUNCH_CODE} and it must never be lost. The retry logic lives in ${MAGIC_FILE}. Read that file, fix the double-free in parseFrame(), and keep the answer short.`, timestamp: Date.now() });
sm.appendMessage({
	role: "assistant",
	content: [
		{ type: "text", text: `I will fix parseFrame() in ${MAGIC_FILE}. Noted the launch code for this session context.` },
		{ type: "toolCall", id: "smoke-1", name: "read", arguments: { path: MAGIC_FILE } },
	],
	api: "anthropic-messages",
	provider: "zai-coding-cn",
	model: "glm-5.3",
	usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: Date.now(),
});
sm.appendMessage({
	role: "toolResult",
	toolCallId: "smoke-1",
	toolName: "read",
	content: [{ type: "text", text: `${MAGIC_FILE} (lines 1-40)\nexport function parseFrame(buf: Buffer) {\n  const header = decodeHeader(buf);\n  free(header);        // BUG: double-free — freed again below\n  const payload = decodePayload(buf, header);\n  free(header);\n  return payload;\n}\n// retry: 3 attempts, exponential backoff, jitter` }],
	isError: false,
	timestamp: Date.now(),
});
sm.appendMessage({ role: "user", content: "Good. Now compact and continue.", timestamp: Date.now() });

console.log(`[smoke] model: ${session.model?.provider}/${session.model?.id ?? "?"}`);
console.log("[smoke] running session.compact() — this makes ONE real summarization call...");
const t0 = Date.now();
const result = await session.compact();
console.log(`[smoke] compact() finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --- assertions on the durable session state ---
const branch: SessionEntry[] = sm.getBranch() as SessionEntry[];
const compaction = [...branch].reverse().find((e): e is CompactionEntry => e.type === "compaction");
assert.ok(compaction, "compaction entry appended to the session");

const details = compaction.details as Record<string, unknown> | undefined;
console.log("[smoke] winning compaction details:", JSON.stringify(details)?.slice(0, 300));
console.log("[smoke] winning summary head:", compaction.summary.slice(0, 200).replace(/\n/g, " "));
if (OPENAI_MODE) {
	// better-compaction must yield; pi-openai-server-compaction (if its auth
	// works) wins, else pi's default compactor runs. Either way: NOT ours.
	assert.notEqual(details?.engine, "jtsang4-better-compaction", "better-compaction must not run for OpenAI Responses models");
	if (details && "remoteCompaction" in details) console.log("[smoke] remote compaction by pi-openai-server-compaction confirmed");
	else console.log("[smoke] note: openai-server-compaction abstained (auth/config); pi default ran — still not ours");
	console.log("\n[smoke] OPENAI YIELD PATH PASSED ✔");
	process.exit(0);
}
assert.equal(details?.engine, "jtsang4-better-compaction", `engine marker (got: ${JSON.stringify(details?.engine)})`);
assert.ok(compaction.firstKeptEntryId, "firstKeptEntryId set");
assert.ok(compaction.tokensBefore > 0, "tokensBefore > 0");

const summary: string = compaction.summary;
assert.ok(summary.length > 50, "summary is substantive");
assert.ok(summary.length < 32000, "summary is not runaway");
assert.ok(/\n## |^## /.test(summary), "summary contains structured sections");
assert.ok(
	summary.includes(LAUNCH_CODE) || summary.includes(MAGIC_FILE),
	"checkpoint preserves at least one seeded fact (recall)",
);
if (details) {
	assert.ok(Array.isArray(details.readFiles) || Array.isArray(details.modifiedFiles), "cumulative file lists present");
	console.log(`[smoke] details: ${JSON.stringify(details)}`);
}
console.log("[smoke] summary preview:\n" + summary.slice(0, 800));

// Kept tail: entries after firstKeptEntryId survive.
const keptIdx = branch.findIndex((e) => "id" in e && e.id === compaction.firstKeptEntryId);
assert.ok(keptIdx >= 0, "firstKeptEntryId exists on the branch");
const tailMessages = branch.slice(keptIdx).filter((e) => e.type === "message");
assert.ok(tailMessages.length >= 1, "kept tail survives compaction");

console.log("\n[smoke] ALL ASSERTIONS PASSED ✔");
process.exit(0);
