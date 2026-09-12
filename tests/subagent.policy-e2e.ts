/** SDK integration: trust, model pinning, reduced/overridden tools, reload and lease handoff. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Snapshot } from "../extensions/subagent/runtime.ts";

const repo = resolve(import.meta.dirname, "..");
const root = await mkdtemp(`${tmpdir()}/pi-subagent-policy-`);
console.log(`Artifacts: ${root}`);
process.env.PI_SUBAGENT_STORAGE_DIR = `${root}/subagents`;
await writeFile(`${root}/AGENTS.md`, "Project context marker: E2E_TRUSTED_PROJECT_MARKER\n");
const settings = SettingsManager.inMemory();
settings.setProjectTrusted(false);
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [repo, `${repo}/tests/fixtures/subagent-provider.ts`] });
await loader.reload();
const { session, extensionsResult } = await createAgentSession({ cwd: root, settingsManager: settings, resourceLoader: loader,
	sessionManager: SessionManager.create(root, root), tools: ["pi_subagent", "read"] });
assert.deepEqual(extensionsResult.errors, []);
const events: unknown[] = [];
session.subscribe((event) => { events.push(event); });
const deadline = setTimeout(() => { console.error("POLICY_TIMEOUT"); process.exit(1); }, 30_000);
await session.bindExtensions({ mode: "json", abortHandler: () => { void session.abort(); } });
const select = async (id: string) => {
	const model = session.modelRuntime.getModels().find((model) => model.provider === "subagent-fixture" && model.id === id);
	assert.ok(model);
	await session.setModel(model);
};
const prompt = async (steps: Record<string, unknown>[]) => session.prompt(`E2E_PARENT ${JSON.stringify(steps)}`);
const latest = () => {
	const result = [...session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "pi_subagent");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false);
	return result.details as Snapshot;
};
const leaseDir = `${root}/subagents/${session.sessionManager.getSessionId()}`;
try {
	await select("scripted");
	await prompt([{ action: "spawn", task: "E2E_POLICY_UNTRUSTED" }, { action: "wait" }]);
	const id = latest().children[0]!.id;
	assert.equal(JSON.parse(latest().children[0]!.output).projectMarker, false);
	assert.deepEqual(JSON.parse(latest().children[0]!.output).tools, ["read"]);
	settings.setProjectTrusted(true);
	await select("alternative");
	await prompt([{ action: "send", id, task: "E2E_POLICY_TRUSTED" }, { action: "wait" }]);
	assert.equal(JSON.parse(latest().children[0]!.output).projectMarker, true);
	assert.equal(JSON.parse(latest().children[0]!.output).model, "scripted", "follow-up keeps its original model");
	const promptHash = JSON.parse(latest().children[0]!.output).systemPromptHash;
	await prompt([{ action: "send", id, task: "E2E_POLICY_CACHE" }, { action: "wait" }]);
	assert.equal(JSON.parse(latest().children[0]!.output).systemPromptHash, promptHash, "run-specific paths must not invalidate the system prompt on every follow-up");
	session.setActiveToolsByName(["pi_subagent"]);
	await prompt([{ action: "send", id, task: "E2E_POLICY_NO_TOOLS" }, { action: "wait" }]);
	assert.deepEqual(JSON.parse(latest().children[0]!.output).tools, []);
	const oldLeases = (await readdir(leaseDir)).filter((name) => name.startsWith(".lease-"));
	assert.equal(oldLeases.length, 1);
	process.env.PI_E2E_OVERRIDE_READ = "1";
	await session.reload();
	session.setActiveToolsByName(["pi_subagent", "read"]);
	assert.notEqual(session.getAllTools().find((tool) => tool.name === "read")!.sourceInfo.source, "builtin");
	assert.match(session.getAllTools().find((tool) => tool.name === "read")!.description, /Policy test override/);
	await prompt([{ action: "send", id, task: "E2E_POLICY_OVERRIDE" }, { action: "wait" }]);
	assert.equal(latest().children[0]!.status, "completed");
	assert.deepEqual(JSON.parse(latest().children[0]!.output).tools, [], "an overridden parent tool cannot grant an unguarded child builtin");
	const newLeases = (await readdir(leaseDir)).filter((name) => name.startsWith(".lease-"));
	assert.equal(newLeases.length, 1);
	assert.notDeepEqual(newLeases, oldLeases);
	console.log("PASS trusted context gating, pinned model, reduced/overridden tool scopes, reload continuation and lease transfer");
} finally {
	delete process.env.PI_E2E_OVERRIDE_READ;
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	clearTimeout(deadline);
	await writeFile(`${root}/events.json`, JSON.stringify(events));
}
assert.deepEqual((await readdir(leaseDir)).filter((name) => name.startsWith(".lease-")), []);
console.log("PASS shutdown releases all archive leases");
