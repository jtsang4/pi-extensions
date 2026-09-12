/** Real-model workflow: parallel code fixes, independent test oracles, report collection. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Snapshot } from "../extensions/subagent/runtime.ts";

const model = process.argv[2];
if (!model) throw new Error("Usage: pnpm exec node --experimental-strip-types tests/subagent.workflow-live.ts provider/model-id");
const repo = resolve(import.meta.dirname, "..");
const piCli = process.env.PI_E2E_PI_BIN ?? "pi";
const root = await mkdtemp(`${tmpdir()}/pi-subagent-workflow-live-`);
console.log(`Artifacts: ${root}`);
const checks = {
	"cart.test.mjs": `import assert from 'node:assert/strict'; import { total } from './cart.mjs';
assert.equal(total([]), 0); assert.equal(total([{price:3, quantity:2},{price:2, quantity:4}]), 14);
assert.equal(total([{price:9, quantity:0}]), 0); assert.equal(total([{price:1.25, quantity:2}]), 2.5);
console.log('E2E_CART_CHECK_PASSED');\n`,
	"emails.test.mjs": `import assert from 'node:assert/strict'; import { uniqueEmails } from './emails.mjs';
assert.deepEqual(uniqueEmails([]), []);
assert.deepEqual(uniqueEmails([' A@Example.COM ', 'a@example.com', ' ', '', 'B@example.com']), ['a@example.com','b@example.com']);
assert.deepEqual(uniqueEmails([' B@X ', 'a@x', 'b@x']), ['b@x','a@x']);
console.log('E2E_EMAILS_CHECK_PASSED');\n`,
};
await Promise.all([
	writeFile(`${root}/cart.mjs`, "export function total(items) { return items.reduce((sum, item) => sum + item.price, 0); }\n"),
	writeFile(`${root}/emails.mjs`, "export function uniqueEmails(items) { return [...new Set(items)]; }\n"),
	...Object.entries(checks).map(([name, text]) => writeFile(`${root}/${name}`, text)),
]);
const tasks = [
	`Modify only ${root}/cart.mjs. total(items) must sum price * quantity, handle empty input as 0, preserve zero quantity and decimal prices. Read the existing file and ${root}/cart.test.mjs, fix the function, then run node ${root}/cart.test.mjs using bash and report its exact success marker. Never edit test files.`,
	`Modify only ${root}/emails.mjs. uniqueEmails(items) must trim whitespace, lowercase addresses, discard empty values, and deduplicate while preserving first occurrence order. Read the file and ${root}/emails.test.mjs, fix it, then run node ${root}/emails.test.mjs using bash and report its exact success marker. Never edit test files.`,
];
const prompt = `E2E_WORKFLOW: Coordinate two independent coding tasks using pi_subagent. Spawn exactly two worker children, one per task, with timeoutMs 60000. Supply each complete task verbatim. Tasks: ${JSON.stringify(tasks)}
Use wait with waitFor:any on their IDs to collect an early result, then wait only for any children still running until both are terminal. Read each full report with pi_subagent result. Inspect statuses and test evidence. You must not call any tools other than pi_subagent yourself. Do not spawn extra children or edit files yourself. Finish with E2E_WORKFLOW_OK plus the two exact check markers only when both children completed and both checks passed; otherwise report the failure. Avoid polling with list or short wait timeouts.`;
const args = ["--offline", "--no-extensions", "-e", repo, "--no-skills", "--no-prompt-templates", "--no-context-files",
	"--session", `${root}/parent.jsonl`, "--mode", "json", "--tools", "pi_subagent,read,write,edit,bash,grep,find,ls", "--model", model, "--thinking", "off", "-p", prompt];
const child = spawn(piCli, args, { cwd: root, env: { ...process.env, PI_SUBAGENT_STORAGE_DIR: `${root}/subagents` }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "", expired = false;
child.stdout.on("data", (data) => { stdout += data; });
child.stderr.on("data", (data) => { stderr += data; });
const timer = setTimeout(() => {
	expired = true;
	try { if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}, 180_000);
const code = await new Promise<number | null>((done, reject) => { child.on("close", done); child.on("error", reject); }).finally(() => clearTimeout(timer));
await Promise.all([writeFile(`${root}/stdout.jsonl`, stdout), writeFile(`${root}/stderr.log`, stderr), writeFile(`${root}/command.json`, JSON.stringify({ cwd: root, executable: piCli, args, pid: child.pid, code, expired }))]);
assert.equal(expired, false);
assert.equal(code, 0, stderr);
assert.equal(stderr, "");
const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
const calls = events.filter((event) => event.type === "tool_execution_start");
assert.ok(calls.every((event) => event.toolName === "pi_subagent"));
assert.equal(calls.filter((event) => event.args.action === "spawn").length, 2);
assert.ok(calls.some((event) => event.args.action === "wait" && event.args.waitFor === "any"));
assert.equal(new Set(calls.filter((event) => event.args.action === "result").map((event) => event.args.id)).size, 2);
const results = events.filter((event) => event.type === "tool_execution_end");
assert.ok(results.every((event) => !event.isError), "all management calls must succeed");
const final = results.at(-1)!.result.details as Snapshot;
assert.equal(final.children.length, 2);
for (const worker of final.children) {
	assert.equal(worker.status, "completed", worker.error ?? "Expected completed worker");
	assert.deepEqual(worker.history, []);
	assert.ok(worker.activity!.usage!.totalTokens > 0);
	const log = (await readFile(`${worker.archiveDir}/events.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(log.some((line) => line.event?.type === "tool_execution_start" && line.event.toolName === "bash"));
	assert.ok(log.some((line) => line.event?.message?.role === "toolResult" && line.event.message.toolName === "bash" && !line.event.message.isError));
	assert.match(await readFile(`${worker.archiveDir}/result.md`, "utf8"), /E2E_(?:CART|EMAILS)_CHECK_PASSED/);
}
for (const [name, text] of Object.entries(checks)) {
	assert.equal(await readFile(`${root}/${name}`, "utf8"), text, "workers must not modify the test oracle");
	const checked = spawnSync(process.execPath, [`${root}/${name}`], { encoding: "utf8", timeout: 10_000 });
	await writeFile(`${root}/${name}.verification.log`, checked.stdout + checked.stderr);
	assert.equal(checked.status, 0, checked.stderr);
}
const assistantText = events.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1)?.message.content.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n");
assert.match(assistantText, /E2E_WORKFLOW_OK/);
assert.match(assistantText, /E2E_CART_CHECK_PASSED/);
assert.match(assistantText, /E2E_EMAILS_CHECK_PASSED/);
assert.throws(() => process.kill(child.pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".mjs")).sort(), ["cart.mjs", "cart.test.mjs", "emails.mjs", "emails.test.mjs"]);
console.log("PASS two real workers fix disjoint files, run unchanged test oracles, expose usage, and parent integrates both full reports");
