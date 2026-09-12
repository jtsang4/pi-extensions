import { StringEnum } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionContext, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SubagentRuntime, bounded, type Child } from "./runtime.ts";

const ROLES = {
	scout: ["read", "grep", "find", "ls"],
	worker: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

export default function subagent(pi: ExtensionAPI): void {
	const runtime = new SubagentRuntime();
	const factory = (ctx: ExtensionContext) => async (child: Child) => {
		const model = ctx.modelRegistry.find(child.model.provider, child.model.id);
		if (!model) throw new Error(`Unavailable subagent model: ${child.model.provider}/${child.model.id}`);
		// Pi currently exposes the shared runtime only through its registry implementation.
		// Fail closed instead of silently losing registered providers or in-memory OAuth.
		const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
		if (!modelRuntime) throw new Error("This Pi version does not expose the active model runtime.");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			noContextFiles: !ctx.isProjectTrusted(),
			systemPromptOverride: () => undefined,
			appendSystemPromptOverride: () => [
				`You are a ${child.role} subagent handling a bounded task for a parent agent. You have a separate conversation and share its working directory. Work only on the assigned task. Other agents may edit files concurrently; do not undo their changes. Return a concise report with evidence, changed paths, checks, and unresolved issues. You cannot delegate. Your tool allowlist is not an OS sandbox.`,
			],
		});
		await loader.reload();
		const manager = SessionManager.inMemory(ctx.cwd);
		for (const message of child.history) {
			if (message.role === "compactionSummary" || message.role === "branchSummary") {
				manager.appendMessage({ role: "user", content: `[Prior context summary]\n${message.summary}`, timestamp: Date.now() });
			} else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "custom" || message.role === "bashExecution") {
				manager.appendMessage(structuredClone(message));
			}
		}
		const active = new Set(pi.getActiveTools());
		const { session } = await createAgentSession({
			cwd: ctx.cwd, model, modelRuntime, sessionManager: manager, settingsManager, resourceLoader: loader,
			thinkingLevel: child.thinking as ReturnType<ExtensionAPI["getThinkingLevel"]>,
			tools: child.tools.filter((tool) => active.has(tool)),
		});
		return session;
	};

	pi.registerTool({
		name: "pi_subagent",
		label: "Subagent",
		description: "Delegate independent tasks to Pi subagents. spawn returns an ID immediately; wait collects results (timeout leaves children running); send steers a running child or starts a follow-up on an idle child; stop cancels; list inspects all children. Default scout has read-only built-ins; worker can modify files using the parent's active built-ins. Separate contexts; no other extensions or their safety hooks. Children share the filesystem. Max 4 active, 32 per branch. Always wait for or stop your children before ending the task.",
		promptSnippet: "Delegate bounded work to independent, continuable subagents",
		promptGuidelines: ["Delegate only independent work that benefits from a separate context. Supply all necessary context in task. Assign non-overlapping files to workers. Inspect child status and evidence before relying on results. A wait timeout is not failure or cancellation."],
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(["spawn", "list", "wait", "send", "stop"]),
			task: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
			id: Type.Optional(Type.String()),
			ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 32 })),
			role: Type.Optional(StringEnum(["scout", "worker"])),
			model: Type.Optional(Type.String({ description: "Exact provider/model-id; defaults to parent's model." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000, description: "Per child turn, default 300000." })),
			maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Model-turn budget per task, default 32." })),
			waitMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000, description: "Wait at most this long for all selected children, default 10000." })),
		}),
		execute: async (_callId, args, signal, _update, ctx) => {
			if (signal?.aborted) throw new Error("Subagent operation cancelled.");
			let selected: string[] = [];
			const requireId = () => {
				if (!args.id) throw new Error(`${args.action} requires id.`);
				return args.id;
			};
			const requireTask = () => {
				if (!args.task?.trim()) throw new Error(`${args.action} requires a nonempty task.`);
				return args.task;
			};
			switch (args.action) {
				case "spawn": {
					const task = requireTask();
					let model = ctx.model;
					if (args.model) {
						const slash = args.model.indexOf("/");
						model = slash > 0 ? ctx.modelRegistry.find(args.model.slice(0, slash), args.model.slice(slash + 1)) : undefined;
					}
					if (!model) throw new Error("Select an available model using provider/model-id.");
					const role = args.role === "worker" ? "worker" : "scout";
					const active = new Set(pi.getActiveTools());
					const builtins = new Set(pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
					selected = [runtime.spawn({ task, role, model: { provider: model.provider, id: model.id },
						thinking: pi.getThinkingLevel(), tools: ROLES[role].filter((tool) => active.has(tool) && builtins.has(tool)),
						timeoutMs: args.timeoutMs ?? 300_000, maxTurns: args.maxTurns ?? 32,
					}, factory(ctx))];
					break;
				}
				case "send": selected = [requireId()]; await runtime.send(selected[0]!, requireTask(), factory(ctx)); break;
				case "stop": selected = [requireId()]; await runtime.stop(selected[0]!); break;
				case "wait":
					selected = args.ids ?? (args.id ? [args.id] : runtime.snapshot().children.map((child) => child.id));
					await runtime.wait(selected, args.waitMs ?? 10_000, signal);
					break;
				case "list": break;
			}
			const details = runtime.snapshot();
			const children = details.children.filter((child) => selected.length === 0 || selected.includes(child.id));
			const outputBytes = args.action === "list" ? 512 : Math.floor(24_000 / Math.max(1, children.length));
			return {
				content: [{ type: "text", text: JSON.stringify(children.map((child) => ({
					id: child.id, role: child.role, task: bounded(child.task, 256), status: child.status, turn: child.turn,
					model: child.model, tools: child.tools, resumable: child.resumable,
					output: bounded(child.output, outputBytes), error: child.error ? bounded(child.error, 512) : undefined,
				}))) }],
				details,
			};
		},
	});
	pi.on("session_start", async (_event, ctx) => { await runtime.shutdown(); runtime.restore(ctx.sessionManager.getBranch()); });
	pi.on("session_before_switch", () => runtime.shutdown());
	pi.on("session_before_fork", () => runtime.shutdown());
	pi.on("session_before_tree", () => runtime.shutdown());
	pi.on("session_tree", (_event, ctx) => runtime.restore(ctx.sessionManager.getBranch()));
	pi.on("session_shutdown", () => runtime.shutdown());
}
