// Deterministic transport fixture. The real Pi CLI, tools, sessions and extension
// are untouched; only model responses are scripted for lifecycle assertions.
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";

function userText(context: Context): string[] {
	return context.messages.filter((message) => message.role === "user").map((message) =>
			(typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).split("\n\n[Subagent run context]\n")[0]!);
}

export default function fixture(pi: ExtensionAPI): void {
	if (process.env.PI_E2E_OVERRIDE_READ === "1") pi.registerTool({
		name: "read", label: "Fixture override", description: "Policy test override of the parent read tool", parameters: Type.Object({ path: Type.String() }),
		async execute() { return { content: [{ type: "text", text: "E2E_OVERRIDDEN_READ" }], details: {} }; },
	});
	pi.registerProvider("subagent-fixture", {
		baseUrl: "https://fixture.invalid", api: "subagent-fixture", apiKey: "fixture-not-a-secret",
		models: ["scripted", "alternative"].map((id) => ({ id, name: `Subagent E2E ${id}`, reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now() };
			const finish = () => {
				if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
				else stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			};
			queueMicrotask(() => {
				try {
					if (options?.signal?.aborted) { message.stopReason = "aborted"; finish(); return; }
					const users = userText(context);
					const first = users[0] ?? "";
					const latest = users.at(-1) ?? "";
					const results = context.messages.filter((item) => item.role === "toolResult");
					const call = (name: string, args: Record<string, unknown>) => {
						message.stopReason = "toolUse";
						message.content = [{ type: "toolCall", id: randomUUID(), name, arguments: args }];
					};
					if (first.startsWith("E2E_PARENT ")) {
						const steps = JSON.parse(latest.slice(11)) as Record<string, unknown>[];
						const parentIndex = context.messages.length - 1 - [...context.messages].reverse().findIndex((item) => item.role === "user");
						const currentResults = context.messages.slice(parentIndex + 1).filter((item) => item.role === "toolResult");
						const step = steps[currentResults.length];
						if (step) {
							const resolve = (value: unknown): unknown => {
								const ref = typeof value === "string" ? value.match(/^\$(\d+)(\.nextOffset)?$/) : null;
								if (ref) {
									const data = JSON.parse(currentResults[Number(ref[1])]!.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
									return ref[2] ? data[0].result.nextOffset : data[0].id;
								}
								if (Array.isArray(value)) return value.map(resolve);
								if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
								return value;
							};
							const resolved = resolve(step) as Record<string, unknown>;
							call("pi_subagent", resolved);
						} else {
							message.content = [{ type: "text", text: "E2E_PARENT_DONE" }];
							const delay = Number(process.env.PI_E2E_PARENT_SETTLE_MS ?? 0);
							if (delay > 0) { setTimeout(finish, delay); return; }
						}
					} else if (latest.startsWith("E2E_REPORT_THEN_ERROR ")) {
						if (results.length === 0) {
							call("read", { path: latest.slice("E2E_REPORT_THEN_ERROR ".length) });
							message.content.unshift({ type: "text", text: "E2E_USEFUL_PROGRESS" });
						} else { message.stopReason = "error"; message.errorMessage = "E2E_AFTER_PROGRESS_ERROR"; }
					} else if (latest === "E2E_EMPTY_REPORT") {
						message.content = [];
					} else if (latest.startsWith("E2E_READ_BLOCK ") && results.length === 0) {
						call("read", { path: latest.slice(15) });
					} else if (latest.startsWith("E2E_BLOCK") || latest.startsWith("E2E_READ_BLOCK ")) {
						const end = () => { message.stopReason = "aborted"; finish(); };
						if (options?.signal?.aborted) end();
						else options?.signal?.addEventListener("abort", end, { once: true });
						return;
					} else if (latest.startsWith("E2E_FAIL")) {
						message.stopReason = "error"; message.errorMessage = "E2E_PROVIDER_ERROR";
					} else if (latest.startsWith("E2E_LENGTH")) {
						message.stopReason = "length"; message.content = [{ type: "text", text: "Incomplete response" }];
					} else if (latest === "E2E_ARTIFACT" && results.length === 0) {
						const task = context.messages.filter((message) => message.role === "user").at(-1)!;
						const text = typeof task.content === "string" ? task.content : task.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
						const match = text.match(/Artifacts directory: ("[^"\n]+")/);
						if (!match) throw new Error("Missing assigned artifact directory in child task");
						call("write", { path: `${JSON.parse(match[1]!)}/report.txt`, content: "E2E_ARTIFACT_OK" });
					} else if (latest.startsWith("E2E_BASH ") && results.length === 0) {
						call("bash", { command: latest.slice(9) });
					} else if (latest.startsWith("E2E_READ ") && results.length === 0) {
						call("read", { path: latest.slice(9) });
					} else if (latest.startsWith("E2E_LOOP ")) {
						call("read", { path: latest.slice(9) });
					} else {
						const report = { marker: "E2E_CHILD_DONE", users, tools: context.tools?.map((tool) => tool.name),
							...(latest.startsWith("E2E_POLICY") ? { model: model.id, projectMarker: context.systemPrompt?.includes("E2E_TRUSTED_PROJECT_MARKER") ?? false, systemPromptHash: createHash("sha256").update(context.systemPrompt ?? "").digest("hex") } : {}),
							results: results.map((result) => ({ isError: result.isError, content: result.content })) };
						message.content = [{ type: "text", text: latest === "E2E_LARGE" ? "大".repeat(30_000) : JSON.stringify(report) }];
					}
					finish();
				} catch (error) { message.stopReason = "error"; message.errorMessage = String(error); finish(); }
			});
			return stream;
		},
	});
}
