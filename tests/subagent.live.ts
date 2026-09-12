/** Provider-backed orchestration smoke test; not part of pnpm test. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Snapshot } from "../extensions/subagent/runtime.ts";

const model = process.argv[2];
if (!model) throw new Error("Usage: pnpm exec node --experimental-strip-types tests/subagent.live.ts provider/model-id [--archive]");
const repo = resolve(import.meta.dirname, "..");
const artifacts = await mkdtemp(`${tmpdir()}/pi-subagent-live-`);
const archive = process.argv.includes("--archive");
const assignedTask = archive ? "Create one worker with this task: Your system prompt provides an artifacts directory. Use write to save live.txt there containing exactly E2E_ARTIFACT_LIVE. Then reply exactly E2E_CHILD_OK." : "Create one scout with this task: Reply exactly E2E_CHILD_OK.";
const prompt = `E2E_SUBAGENT_LIVE: Use pi_subagent spawn. ${assignedTask} Then use pi_subagent wait for that id until terminal. If completed, send to the same id this follow-up: What exact marker did you reply previously? Reply that marker followed by E2E_FOLLOWUP_OK. Wait until terminal again. Finally reply E2E_PARENT_OK only if both turns completed. Do not call other tools yourself or spawn additional children.`;
const args = ["--offline", "--no-extensions", "-e", repo, "--no-skills", "--no-prompt-templates", "--no-context-files",
	...(archive ? ["--session", `${artifacts}/parent-session.jsonl`] : ["--no-session"]), "--mode", "json", "--tools", `pi_subagent,read,grep,find,ls${archive ? ",write" : ""}`, "--model", model, "--thinking", "off", "-p", prompt];
const child = spawn("pi", args, { cwd: repo, env: { ...process.env, PI_SUBAGENT_STORAGE_DIR: `${artifacts}/subagents` }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "", expired = false;
child.stdout.on("data", (data) => { stdout += data; });
child.stderr.on("data", (data) => { stderr += data; });
const timer = setTimeout(() => {
	expired = true;
	if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
	else child.kill("SIGKILL");
}, 180_000);
const code = await new Promise<number | null>((done, reject) => { child.on("close", done); child.on("error", reject); }).finally(() => clearTimeout(timer));
await Promise.all([
	writeFile(`${artifacts}/stdout.jsonl`, stdout), writeFile(`${artifacts}/stderr.log`, stderr),
	writeFile(`${artifacts}/command.json`, JSON.stringify({ cwd: repo, executable: "pi", args, pid: child.pid, code, expired })),
]);
console.log(`Artifacts: ${artifacts}`);
assert.equal(expired, false, "provider-backed run exceeded 180 seconds");
assert.equal(code, 0);
assert.equal(stderr, "");
const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const calls = events.filter((event) => event.type === "tool_execution_start");
assert.ok(calls.every((event) => event.toolName === "pi_subagent"));
assert.equal(calls.filter((event) => event.args.action === "spawn").length, 1);
assert.equal(calls.filter((event) => event.args.action === "send").length, 1);
assert.ok(calls.filter((event) => event.args.action === "wait").length >= 2);
const results = events.filter((event) => event.type === "tool_execution_end");
assert.ok(results.every((event) => !event.isError), "all management operations succeeded");
const snapshots = results.map((event) => event.result.details as Snapshot);
assert.ok(snapshots.some((snapshot) => snapshot.children.some((child) => child.turn === 1 && child.status === "completed" && child.output.includes("E2E_CHILD_OK"))));
const final = snapshots.at(-1)!.children[0]!;
assert.equal(final.status, "completed");
assert.equal(final.turn, 2);
assert.match(final.output, /E2E_CHILD_OK/);
assert.match(final.output, /E2E_FOLLOWUP_OK/);
assert.ok(events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some((part: { text?: string }) => part.text?.includes("E2E_PARENT_OK"))));
if (archive) {
	const first = snapshots.flatMap((snapshot) => snapshot.children).find((child) => child.turn === 1 && child.status === "completed")!;
	assert.equal(await readFile(`${first.archiveDir}/artifacts/live.txt`, "utf8"), "E2E_ARTIFACT_LIVE");
	assert.match(await readFile(`${final.archiveDir}/result.md`, "utf8"), /E2E_FOLLOWUP_OK/);
	assert.deepEqual(final.history, []);
	console.log("PASS real worker saves assigned artifact; both turns archived with compact parent references");
}
console.log("PASS real parent delegation, terminal result collection, child continuation and recall");
