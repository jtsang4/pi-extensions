/** Real SDK lifecycle supplement to the package-level CLI E2E matrix. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "../extensions/subagent/runtime.ts";

const repo = resolve(import.meta.dirname, "..");
const artifacts = await mkdtemp(`${tmpdir()}/pi-subagent-branch-`);
process.env.PI_SUBAGENT_STORAGE_DIR = `${artifacts}/subagents`;
const deadline = setTimeout(() => { console.error("E2E_BRANCH_TIMEOUT"); process.exit(1); }, 30_000);
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: repo, agentDir: artifacts, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [repo, `${repo}/tests/fixtures/subagent-provider.ts`] });
await loader.reload();
const { session, extensionsResult } = await createAgentSession({ cwd: repo, resourceLoader: loader, settingsManager,
	sessionManager: SessionManager.create(repo, artifacts), tools: ["pi_subagent", "read"] });
assert.deepEqual(extensionsResult.errors, []);
assert.ok(extensionsResult.extensions.some((extension) => extension.path === `${repo}/extensions/subagent/index.ts`));
const events: unknown[] = [];
session.subscribe((event) => { events.push(event); });
await session.bindExtensions({ mode: "json", abortHandler: () => { void session.abort(); } });
const model = session.modelRuntime.getModels().find((model) => model.provider === "subagent-fixture");
assert.ok(model);
await session.setModel(model);
const prompt = async (steps: Record<string, unknown>[]) => session.prompt(`E2E_PARENT ${JSON.stringify(steps)}`);
const latest = () => {
	const result = [...session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "pi_subagent");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false);
	return result.details as Snapshot;
};
try {
	await prompt([]);
	const root = session.sessionManager.getLeafId()!;
	await prompt([{ action: "spawn", task: "E2E_BLOCK" }, { action: "wait", waitMs: 30 }]);
	const childId = latest().children[0]!.id;
	const checkpoint = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult").at(-1)!.id;
	assert.equal(latest().children[0]!.status, "running");
	await session.navigateTree(root, { summarize: false });
	await prompt([{ action: "list" }]);
	assert.equal(latest().children.length, 0, "abandoned branch children must not leak");
	await session.navigateTree(checkpoint, { summarize: false });
	await prompt([{ action: "list" }]);
	assert.equal(latest().children[0]!.id, childId);
	assert.equal(latest().children[0]!.status, "stopped", "durable running handles are never resurrected");
	await prompt([{ action: "send", id: childId, task: "E2E_BRANCH_RESUME" }, { action: "wait" }]);
	assert.equal(latest().children[0]!.status, "completed");
	assert.match(latest().children[0]!.output, /E2E_BRANCH_RESUME/);
	const old = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult").at(-1)!.id;
	const firstArchive = latest().children[0]!.checkpoint;
	await prompt([{ action: "send", id: childId, task: "E2E_FUTURE_BRANCH" }, { action: "wait" }]);
	const futureArchive = latest().children[0]!.checkpoint;
	await session.navigateTree(old, { summarize: false });
	await prompt([{ action: "send", id: childId, task: "E2E_OTHER_BRANCH" }, { action: "wait" }]);
	assert.doesNotMatch(latest().children[0]!.output, /E2E_FUTURE_BRANCH/);
	assert.match(latest().children[0]!.output, /E2E_BRANCH_RESUME/);
	assert.notDeepEqual(latest().children[0]!.checkpoint, firstArchive);
	assert.notDeepEqual(latest().children[0]!.checkpoint, futureArchive);
	console.log("PASS package discovery, real tree navigation, branch isolation, interrupted restoration and continuation");
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "pi_subagent" && event.args.waitMs === 60_000) {
			setTimeout(() => { void session.abort(); }, 20);
		}
	});
	await prompt([{ action: "spawn", task: "E2E_BLOCK" }, { action: "wait", waitMs: 60_000 }]);
	unsubscribe();
	await prompt([{ action: "list" }]);
	const running = latest().children.find((child) => child.status === "running");
	assert.ok(running, "aborting parent wait must leave the child running");
	await prompt([{ action: "stop", id: running.id }]);
	assert.ok(latest().children.every((child) => child.status !== "running"));
	console.log("PASS actual parent wait cancellation preserves child, explicit stop settles it");
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	clearTimeout(deadline);
	await writeFile(`${artifacts}/events.json`, JSON.stringify(events));
	console.log(`Artifacts: ${artifacts}`);
}
