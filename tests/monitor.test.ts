import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import monitorExtension from "../extensions/monitor.ts";

type CapturedTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
};

type CapturedCommand = {
	handler: (...args: unknown[]) => Promise<unknown>;
};

type SentMessage = {
	message: { content: string };
	options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
};

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(timer);
				reject(new Error("Timed out waiting for monitor output"));
			}
		}, 10);
	});
}

test("runs, lists, and stops concurrent monitors", async (t) => {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const messages: SentMessage[] = [];
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: CapturedCommand) {
			commands.set(name, command);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	monitorExtension(pi);
	t.after(async () => handlers.get("session_shutdown")?.({}, {}));

	const start = tools.get("pi_background_monitor");
	const list = tools.get("pi_background_monitor_list");
	const stop = tools.get("pi_background_monitor_stop");
	const showMonitors = commands.get("monitors");
	assert.ok(start);
	assert.ok(list);
	assert.ok(stop);
	assert.ok(showMonitors);

	const script = "console.log('&'.repeat(4000)); console.log('first event'); console.log('second event'); setInterval(() => {}, 1000)";
	const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
	const first = (await start.execute(
		"start-first",
		{ description: "test monitor", command, persistent: true },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	)) as { details: { id: string } };
	const quietCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
	const second = (await start.execute(
		"start-second",
		{ description: "quiet monitor", command: quietCommand, persistent: true },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	)) as { details: { id: string } };

	const listed = (await list.execute("list-call", {})) as {
		content: Array<{ text: string }>;
		details: { monitors: Array<{ id: string; command: string }>; concurrencyLimit: null };
	};
	assert.equal(listed.details.monitors.length, 2);
	assert.deepEqual(
		listed.details.monitors.map((monitor) => monitor.id),
		[first.details.id, second.details.id],
	);
	assert.equal(listed.details.monitors[1].command, quietCommand);
	assert.match(listed.content[0].text, /Active monitors: 2 \(no extension limit/);

	await showMonitors.handler("", {
		ui: { notify: (message: string) => notifications.push(message) },
	});
	assert.match(notifications[0], /quiet monitor/);
	assert.match(notifications[0], new RegExp(second.details.id));

	await waitFor(() => messages.length > 0);
	assert.match(messages[0].message.content, /first event/);
	assert.match(messages[0].message.content, /second event/);
	assert.match(messages[0].message.content, /escaped event capped/);
	assert.ok(Buffer.byteLength(messages[0].message.content) <= 16 * 1024);
	assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });

	const stopped = (await stop.execute("stop-one", { id: first.details.id })) as {
		details: { stoppedIds: string[] };
	};
	assert.deepEqual(stopped.details.stoppedIds, [first.details.id]);

	const remaining = (await list.execute("list-remaining", {})) as {
		details: { monitors: Array<{ id: string }> };
	};
	assert.deepEqual(remaining.details.monitors.map((monitor) => monitor.id), [second.details.id]);

	const stoppedAll = (await stop.execute("stop-all", {})) as { details: { stoppedIds: string[] } };
	assert.deepEqual(stoppedAll.details.stoppedIds, [second.details.id]);
});
