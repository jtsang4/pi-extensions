/** Run: pnpm exec node --experimental-strip-types tests/subagent.e2e.ts */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Snapshot } from "../extensions/subagent/runtime.ts";

const repo = resolve(import.meta.dirname, "..");
const artifacts = await mkdtemp(`${tmpdir()}/pi-subagent-e2e-`);
console.log(`Artifacts: ${artifacts}`);
const dataFile = `${artifacts}/input.txt`;
await writeFile(dataFile, "E2E_FILE_CONTENT\n");

type Result = { isError: boolean; details: Snapshot; content: { type: string; text: string }[] };
async function run(name: string, steps: Record<string, unknown>[], extra: string[] = []) {
	const args = ["--offline", "--no-extensions", "-e", repo, "-e", `${repo}/tests/fixtures/subagent-provider.ts`,
		"--no-skills", "--no-prompt-templates", "--no-context-files", ...(extra.includes("--session") ? [] : ["--no-session"]), "--mode", "json", "--thinking", "off",
		"--model", "subagent-fixture/scripted", "--tools", "pi_subagent,read,grep,find,ls,bash,write,edit", ...extra, "-p", `E2E_PARENT ${JSON.stringify(steps)}`];
	await writeFile(`${artifacts}/${name}.command.json`, JSON.stringify({ cwd: repo, executable: "pi", args }));
	const child = spawn("pi", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
	let stdout = "", stderr = "";
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
		else child.kill("SIGKILL");
	}, 30_000);
	const code = await new Promise<number | null>((done, reject) => { child.on("close", done); child.on("error", reject); }).finally(() => clearTimeout(timer));
	await Promise.all([
		writeFile(`${artifacts}/${name}.jsonl`, stdout), writeFile(`${artifacts}/${name}.stderr`, stderr),
		writeFile(`${artifacts}/${name}.exit.json`, JSON.stringify({ code, expired, pid: child.pid })),
	]);
	assert.equal(expired, false, `${name}: outer deadline`);
	assert.equal(code, 0, `${name}: CLI exit; ${stderr}`);
	assert.equal(stderr, "", `${name}: unexpected stderr`);
	const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const results: Result[] = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "pi_subagent").map((event) => ({ ...event.result, isError: event.isError }));
	assert.equal(results.length, steps.length, `${name}: all scripted tool calls executed`);
	assert.ok(events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some((part: { text?: string }) => part.text === "E2E_PARENT_DONE")), `${name}: terminal marker`);
	return results;
}
const lastChild = (results: Result[]) => results.at(-1)!.details.children[0]!;
const spawnTask = (task: string, extra = {}) => ({ action: "spawn", task, ...extra });
const wait = { action: "wait", waitMs: 10_000 };

const normal = await run("normal", [spawnTask(`E2E_READ ${dataFile}`), wait, { action: "send", id: "$0", task: "E2E_FOLLOWUP" }, wait]);
assert.ok(normal.every((result) => !result.isError));
assert.equal(lastChild(normal).status, "completed");
assert.equal(lastChild(normal).turn, 2);
const report = JSON.parse(lastChild(normal).output);
assert.deepEqual(report.tools.sort(), ["find", "grep", "ls", "read"]);
assert.ok(report.users.includes("E2E_FOLLOWUP"));
assert.ok(JSON.stringify(report.results).includes("E2E_FILE_CONTENT"));
console.log("PASS normal, real read tool, scout allowlist, same-context follow-up");

const concurrency = await run("concurrency", [
	...Array.from({ length: 4 }, () => spawnTask("E2E_BLOCK")), spawnTask("E2E_BLOCK"),
	{ action: "wait", waitMs: 50 }, { action: "send", id: "$0", task: "E2E_STEER" },
	...["$0", "$1", "$2", "$3"].map((id) => ({ action: "stop", id })),
	{ action: "list" },
]);
assert.equal(concurrency[4]!.isError, true);
assert.equal(concurrency[5]!.isError, false);
assert.ok(concurrency[5]!.details.children.every((child) => child.status === "running"));
assert.equal(concurrency[6]!.isError, false);
assert.ok(concurrency.at(-1)!.details.children.every((child) => child.status === "stopped"));
console.log("PASS concurrency, wait timeout, busy steering, stop");

const steering = await run("steering-delivery", [spawnTask("E2E_BASH sleep 0.5", { role: "worker" }),
	{ action: "wait", waitMs: 100 }, { action: "send", id: "$0", task: "E2E_STEER_DELIVERED" }, wait]);
assert.ok(steering.every((result) => !result.isError));
assert.equal(lastChild(steering).status, "completed");
const steeredReport = JSON.parse(lastChild(steering).output);
assert.ok(steeredReport.users.includes("E2E_STEER_DELIVERED"));
const history = lastChild(steering).history;
const toolIndex = history.findIndex((message) => message.role === "toolResult");
const steeringIndex = history.findIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("E2E_STEER_DELIVERED"));
assert.ok(toolIndex >= 0 && steeringIndex > toolIndex, "steering follows the active tool batch");
console.log("PASS actual steering delivery after active tool batch");

const restricted = await run("parent-tool-restriction", [spawnTask("E2E_TOOLS", { role: "worker" }), wait], ["--tools", "pi_subagent,read"]);
assert.deepEqual(JSON.parse(lastChild(restricted).output).tools, ["read"]);
console.log("PASS worker cannot expand the parent built-in allowlist");

for (const [name, task, extra, expected] of [
	["timeout", "E2E_BLOCK", { timeoutMs: 1000 }, "stopped"],
	["provider-error", "E2E_FAIL", {}, "failed"],
	["length", "E2E_LENGTH", {}, "failed"],
	["turn-limit", `E2E_LOOP ${dataFile}`, { maxTurns: 2 }, "stopped"],
	["large", "E2E_LARGE", {}, "completed"],
] as const) {
	const results = await run(name, [spawnTask(task, extra), wait]);
	assert.equal(lastChild(results).status, expected, name);
	if (name === "large") { assert.match(lastChild(results).output, /truncated/); assert.ok(Buffer.byteLength(lastChild(results).output) < 16_500); }
	console.log(`PASS ${name}`);
}

const invalid = await run("invalid", [{ action: "spawn", task: " " }, { action: "send", id: "unknown", task: "hello" }, { action: "spawn", task: "hello", model: "missing/model" }]);
assert.ok(invalid.every((result) => result.isError));
console.log("PASS invalid requests");

const sessionPath = `${artifacts}/persisted.jsonl`;
const persisted = await run("persist", [spawnTask("E2E_REMEMBER_7391"), wait], ["--session", sessionPath]);
const restored = await run("restore", [{ action: "send", id: lastChild(persisted).id, task: "E2E_RECALL" }, wait], ["--session", sessionPath]);
assert.equal(lastChild(restored).status, "completed");
assert.equal(lastChild(restored).turn, 2);
assert.ok(JSON.parse(lastChild(restored).output).users.includes("E2E_REMEMBER_7391"));
console.log("PASS durable restoration in a new CLI process");

// Exercise the actual built-in bash cancellation, including its descendant.
for (const mode of ["stop", "timeout", "shutdown"] as const) {
	const pidFile = `${artifacts}/${mode}.pid`;
	const command = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)'`;
	const steps: Record<string, unknown>[] = [spawnTask(`E2E_BASH ${command}`, { role: "worker", timeoutMs: mode === "timeout" ? 1000 : 20_000 }), { action: "wait", waitMs: mode === "timeout" ? 3000 : 500 }];
	if (mode === "stop") steps.push({ action: "stop", id: "$0" });
	const results = await run(`bash-${mode}`, steps);
	const pid = Number(await readFile(pidFile, "utf8"));
	assert.ok(pid > 0);
	assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH", `${mode}: descendant ${pid} was cleaned up`);
	if (mode !== "shutdown") assert.equal(lastChild(results).status, "stopped");
	console.log(`PASS bash ${mode}; descendant ${pid} removed`);
}
console.log("E2E_SUBAGENT_MATRIX_PASSED");
