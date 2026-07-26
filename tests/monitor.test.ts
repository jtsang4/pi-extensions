import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import monitorExtension from "../extensions/monitor.ts";

type CapturedTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
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

test("streams command output into the session and stops the process", async (t) => {
	const tools = new Map<string, CapturedTool>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const messages: SentMessage[] = [];
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
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
	const stop = tools.get("pi_background_monitor_stop");
	assert.ok(start);
	assert.ok(stop);

	const script = "console.log('&'.repeat(4000)); console.log('first event'); console.log('second event'); setInterval(() => {}, 1000)";
	const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
	const result = (await start.execute(
		"start-call",
		{ description: "test monitor", command, persistent: true },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	)) as { details: { id: string } };
	const id = result.details.id;

	await waitFor(() => messages.length > 0);
	assert.match(messages[0].message.content, /first event/);
	assert.match(messages[0].message.content, /second event/);
	assert.match(messages[0].message.content, /escaped event capped/);
	assert.ok(Buffer.byteLength(messages[0].message.content) <= 16 * 1024);
	assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });

	const stopped = (await stop.execute("stop-call", { id })) as { details: { stoppedIds: string[] } };
	assert.deepEqual(stopped.details.stoppedIds, [id]);
});
