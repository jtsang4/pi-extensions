/** Package-level abrupt-exit check: recorded progress survives without replaying work. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Snapshot } from "../extensions/subagent/runtime.ts";

const repo = resolve(import.meta.dirname, "..");
const artifacts = await mkdtemp(`${tmpdir()}/pi-subagent-crash-`);
console.log(`Artifacts: ${artifacts}`);
const sessionPath = `${artifacts}/parent-session.jsonl`;
const dataFile = `${artifacts}/input.txt`;
await writeFile(dataFile, "E2E_CRASH_PROGRESS\n");
const prefix = ["--offline", "--no-extensions", "-e", repo, "-e", `${repo}/tests/fixtures/subagent-provider.ts`,
	"--no-skills", "--no-prompt-templates", "--no-context-files", "--session", sessionPath,
	"--mode", "json", "--model", "subagent-fixture/scripted", "--thinking", "off", "--tools", "pi_subagent,read"];
const steps = [{ action: "spawn", role: "scout", task: `E2E_READ_BLOCK ${dataFile}`, timeoutMs: 60_000 }];
const args = [...prefix, "-p", `E2E_PARENT ${JSON.stringify(steps)}`];
const env = { ...process.env, PI_SUBAGENT_STORAGE_DIR: `${artifacts}/subagents`, PI_E2E_PARENT_SETTLE_MS: "10000" };
const child = spawn("pi", args, { cwd: repo, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (data) => { stdout += data; });
child.stderr.on("data", (data) => { stderr += data; });
const closed = new Promise<void>((done, reject) => { child.on("close", () => done()); child.on("error", reject); });
const kill = () => {
	try { if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
};
const timer = setTimeout(kill, 15_000);
let archived: Snapshot["children"][number] | undefined;
try {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const events = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
		archived = events.find((event) => event.type === "tool_execution_end" && event.toolName === "pi_subagent")?.result.details.children[0];
		if (archived?.archiveDir) {
			try {
				const log = await readFile(`${archived.archiveDir}/events.jsonl`, "utf8");
				if (log.includes("tool_execution_start") && log.includes("E2E_CRASH_PROGRESS")) break;
			} catch { /* Wait for actual worker startup and incremental archive writes. */ }
		}
		await new Promise((done) => setTimeout(done, 20));
	}
	assert.ok(archived?.archiveDir);
	const before = await readFile(`${archived.archiveDir}/events.jsonl`, "utf8");
	assert.match(before, /tool_execution_start/);
	assert.match(before, /E2E_CRASH_PROGRESS/);
	await assert.rejects(readFile(`${archived.archiveDir}/result.md`), { code: "ENOENT" });
	kill();
	await closed;
	assert.equal(stderr, "");
	assert.throws(() => process.kill(child.pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
	const persisted = await readFile(`${archived.archiveDir}/events.jsonl`, "utf8");
	assert.match(persisted, /E2E_CRASH_PROGRESS/);
	for (const line of persisted.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
	const resumed = spawnSync("pi", [...prefix, "-p", 'E2E_PARENT [{"action":"list"}]'], {
		cwd: repo, env: { ...env, PI_E2E_PARENT_SETTLE_MS: "0" }, encoding: "utf8", timeout: 15_000,
	});
	await writeFile(`${artifacts}/restored.jsonl`, resumed.stdout);
	assert.equal(resumed.status, 0, resumed.stderr);
	assert.equal(resumed.stderr, "");
	const result = resumed.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
		.find((event) => event.type === "tool_execution_end" && event.toolName === "pi_subagent");
	assert.equal(result.result.details.children[0].status, "stopped");
	assert.equal(result.result.details.children[0].turn, 1);
	assert.equal(result.result.details.children[0].archiveDir, archived.archiveDir);
	assert.equal(await readFile(`${archived.archiveDir}/events.jsonl`, "utf8"), persisted, "resume does not rerun or mutate the crashed archive");
	console.log("PASS incremental archival survives SIGKILL, parent resumes stopped, no automatic replay, process group cleaned up");
} finally {
	clearTimeout(timer);
	kill();
	await closed;
	await Promise.all([writeFile(`${artifacts}/stdout.jsonl`, stdout), writeFile(`${artifacts}/stderr.log`, stderr), writeFile(`${artifacts}/command.json`, JSON.stringify({ args, pid: child.pid }))]);
}
