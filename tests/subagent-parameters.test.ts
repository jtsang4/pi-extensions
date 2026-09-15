import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { normalizeArguments, parameters } from "../extensions/subagent/parameters.ts";

const populated = { action: "spawn" as const, task: "Inspect the assigned file", id: "", ids: ["placeholder"],
	role: "scout" as const, model: "", timeoutMs: 300_000, maxTurns: 20, waitMs: 1000, waitFor: "all" as const, offset: 0 };
const nullable = { task: null, id: null, ids: null, role: null, model: null, timeoutMs: null, maxTurns: null,
	waitMs: null, waitFor: null, offset: null };

test("remote spawn shapes ignore management placeholders before resolving IDs", () => {
	for (const id of ["", "unused"]) for (const placeholder of ["placeholder", "unused", "x"]) {
		const input = { ...populated, id, ids: [placeholder] };
		assert.ok(Check(parameters, input));
		const { args, ignoredParameters } = normalizeArguments(input);
		assert.deepEqual(args, { action: "spawn", task: populated.task, role: "scout", model: undefined, timeoutMs: 300_000, maxTurns: 20 });
		assert.deepEqual(ignoredParameters, ["id", "ids", "waitMs", "waitFor", "offset"]);
		assert.deepEqual(input.ids, [placeholder], "do not mutate the original tool call");
	}
});

test("sparse and fully required nullable schemas preserve the same default arguments", () => {
	const strictShape = { ...parameters, required: Object.keys(parameters.properties) };
	for (const action of ["spawn", "send", "wait", "stop", "forget", "result", "list"] as const) {
		const full = { ...nullable, action };
		assert.ok(Check(strictShape, full), action);
		assert.deepEqual(normalizeArguments(full), normalizeArguments({ action }));
	}
	assert.ok(Check(parameters, { action: "list", task: "" }));
	assert.deepEqual(normalizeArguments({ action: "list", task: "" }), { args: { action: "list" }, ignoredParameters: ["task"] });
});

test("follow-ups cannot change their child's configuration through unused fields", () => {
	const input = { ...populated, action: "send" as const, id: "existing-id", role: "worker" as const, model: "other/model", maxTurns: 100 };
	const { args, ignoredParameters } = normalizeArguments(input);
	assert.deepEqual(args, { action: "send", id: "existing-id", task: populated.task });
	assert.deepEqual(ignoredParameters, ["ids", "role", "model", "timeoutMs", "maxTurns", "waitMs", "waitFor", "offset"]);
});

test("wait selection accepts omitted selectors but rejects ambiguous nonempty selectors", () => {
	assert.deepEqual(normalizeArguments({ action: "wait", id: "  ", ids: [] }).args, { action: "wait", id: undefined });
	assert.deepEqual(normalizeArguments({ action: "wait", id: null, ids: ["child"] }).args, { action: "wait", ids: ["child"] });
	assert.deepEqual(normalizeArguments({ action: "wait", id: " child ", ids: [] }).args, { action: "wait", id: "child" });
	assert.throws(() => normalizeArguments({ action: "wait", id: "child", ids: ["child"] }), /Choose id or ids/);
	assert.deepEqual(normalizeArguments({ action: "result", id: "child", ids: ["placeholder"], offset: 0 }).args,
		{ action: "result", id: "child", offset: 0 });
});

test("nullable options retain schema type, size, range and unknown-field checks", () => {
	for (const invalid of [
		{ task: 42 }, { task: "x".repeat(32_001) }, { ids: [""] }, { ids: Array(33).fill("child") },
		{ role: "admin" }, { model: false }, { timeoutMs: 999 }, { timeoutMs: 600_001 },
		{ maxTurns: 0 }, { maxTurns: 101 }, { maxTurns: 1.5 }, { waitMs: 0 }, { waitMs: 60_001 },
		{ waitFor: "none" }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { unknownField: null },
	]) assert.equal(Check(parameters, { action: "spawn", ...invalid }), false, JSON.stringify(invalid).slice(0, 100));
	assert.throws(() => normalizeArguments({ action: "list", ...{ unknownField: null } }), /Unknown subagent parameter/);
});

test("Pi validation preserves nulls and zero offsets without coercing invalid budgets to null", () => {
	const validate = (args: Record<string, unknown>) => validateToolArguments({ name: "pi_subagent", description: "test", parameters },
		{ type: "toolCall", id: "test", name: "pi_subagent", arguments: args });
	const input = { ...nullable, action: "spawn", task: "Inspect the assigned file" };
	assert.deepEqual(validate(input), input);
	assert.deepEqual(validate({ action: "result", id: "child", offset: 0 }), { action: "result", id: "child", offset: 0 });
	for (const invalid of [{ maxTurns: 0 }, { timeoutMs: 0 }, { waitMs: 0 }, { offset: -1 }]) {
		assert.throws(() => validate({ action: "spawn", task: "Inspect", ...invalid }), /Validation failed/);
	}
});
