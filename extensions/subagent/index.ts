import {
	createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionContext, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { SubagentRuntime, bounded, type Child } from "./runtime.ts";
import { SubagentStorage, type ResultPage } from "./storage.ts";
import { normalizeArguments, parameters } from "./parameters.ts";
import { join } from "node:path";

const ROLES = {
	scout: ["read", "grep", "find", "ls"],
	worker: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

export default function subagent(pi: ExtensionAPI): void {
	const runtime = new SubagentRuntime();
	let initializationAttempted = false;
	let initializationError: unknown;
	let activeStore: SubagentStorage | undefined;
	let lastCleanupAt = 0;
	let lastCleanupSettings = "";
	const activeBuiltins = () => {
		const active = new Set(pi.getActiveTools());
		return new Set(pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin" && active.has(tool.name)).map((tool) => tool.name));
	};
	const restore = async (ctx: ExtensionContext) => {
		initializationAttempted = true;
		initializationError = new Error("Subagent storage is initializing.");
		let store: SubagentStorage | undefined;
		try {
			await runtime.shutdown();
			store = ctx.sessionManager.getSessionFile() ? SubagentStorage.fromEnvironment() : undefined;
			await runtime.restore(ctx.sessionManager.getBranch(), store ? { store, parentId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, branchId: ctx.sessionManager.getLeafId() } : undefined);
			const parents = new Set([ctx.sessionManager.getSessionId()]);
			if (store) {
				for (const child of runtime.snapshot().children) {
					if (child.checkpoint) parents.add(child.checkpoint.parentId);
					if (child.archive) parents.add(child.archive.parentId);
				}
				for (const parent of parents) await store.protect(parent);
			}
			const previous = activeStore;
			activeStore = store;
			try { await previous?.release(); }
			catch (error) { if (ctx.hasUI) ctx.ui.notify(`Subagent lease cleanup failed: ${String(error)}`, "warning"); }
			if (store) {
				try {
					const settings = JSON.stringify([store.root, store.retentionDays, store.maxBytes]);
					if (settings !== lastCleanupSettings || Date.now() - lastCleanupAt >= 300_000) {
						await store.prune(Date.now(), parents);
						lastCleanupAt = Date.now();
						lastCleanupSettings = settings;
					}
				}
				catch (error) { if (ctx.hasUI) ctx.ui.notify(`Subagent archive cleanup failed: ${String(error)}`, "warning"); }
			}
			initializationError = undefined;
		} catch (error) {
			if (store !== activeStore) await store?.release().catch(() => {});
			initializationError = error;
			throw error;
		}
	};
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
				"When a task includes subagent run context, its run and final report are archived automatically. If your tools allow writing, use the artifacts directory provided with the current task for temporary reports and test logs. Keep project deliverables in their requested paths. List artifacts in your final report.",
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
		const active = activeBuiltins();
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
		description: "Delegate independent tasks to Pi subagents. spawn returns an ID immediately; wait collects all selected results or waitFor:any returns when one finishes (timeout leaves children running); send steers a running child or starts a follow-up on an idle child; stop cancels; list shows results, progress and usage; result reads the full archived report in bounded pages using offset/nextOffset; forget removes a terminal child from this branch while keeping its archives. Default scout has read-only built-ins; worker can modify files using the parent's active built-ins. Separate contexts; no other extensions or their safety hooks. Children share the filesystem. Max 4 active, 32 per branch. Always wait for or stop your children before ending the task.",
		promptSnippet: "Delegate bounded work to independent, continuable subagents",
		promptGuidelines: ["Delegate only independent work that benefits from a separate context. Supply all necessary context and success criteria in task. Assign non-overlapping files to workers. Inspect child status and evidence before relying on results. A wait timeout is not failure or cancellation. Use waitFor:any with running IDs to act on early results; exclude already-completed IDs from subsequent waits. Use forget for finished, unrelated tasks when record capacity is needed.",
			"Supply only the fields for the chosen action; omit unused options or set them to null. Known fields for other actions are ignored and listed as ignoredParameters on returned child records. Do not invent placeholder IDs. Only spawn configures model, role and budgets; send keeps the child's original configuration."],
		executionMode: "sequential",
		parameters,
		execute: async (_callId, input, signal, _update, ctx) => {
			if (signal?.aborted) throw new Error("Subagent operation cancelled.");
			const { args, ignoredParameters } = normalizeArguments(input);
			if (!initializationAttempted) await restore(ctx);
			if (signal?.aborted) throw new Error("Subagent operation cancelled before admission.");
			if (initializationError) throw new Error(`Subagent storage initialization failed: ${String(initializationError)}`);
			runtime.setBranch(ctx.sessionManager.getLeafId());
			let selected: string[] = [];
			let resultPage: ResultPage | undefined;
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
					const active = activeBuiltins();
					selected = [runtime.spawn({ task, role, model: { provider: model.provider, id: model.id },
						thinking: pi.getThinkingLevel(), tools: ROLES[role].filter((tool) => active.has(tool)),
						timeoutMs: args.timeoutMs ?? 300_000, maxTurns: args.maxTurns ?? 32,
					}, factory(ctx))];
					break;
				}
				case "send": selected = [requireId()]; await runtime.send(selected[0]!, requireTask(), factory(ctx), signal); break;
				case "stop": selected = [requireId()]; await runtime.stop(selected[0]!); break;
				case "forget": runtime.forget(requireId()); break;
				case "result": selected = [requireId()]; resultPage = await runtime.result(selected[0]!, args.offset); break;
				case "wait":
					selected = args.ids ?? (args.id ? [args.id] : runtime.snapshot().children.map((child) => child.id));
					await runtime.wait(selected, args.waitMs ?? 10_000, signal, args.waitFor === "any" ? "any" : "all");
					break;
				case "list": break;
			}
			if (signal?.aborted) throw new Error("Subagent operation cancelled; inspect list for the state of any already accepted work.");
			const details = runtime.snapshot();
			const children = details.children.filter((child) => selected.length === 0 || selected.includes(child.id)).map((child) => runtime.get(child.id));
			const outputBytes = args.action === "list" || resultPage ? 512 : Math.floor(24_000 / Math.max(1, children.length));
			return {
				content: [{ type: "text", text: JSON.stringify(children.map((child) => ({
					id: child.id, role: child.role, task: bounded(child.task, 256), status: child.status, turn: child.turn,
					model: child.model, tools: child.tools, resumable: child.resumable,
					ignoredParameters: ignoredParameters.length ? ignoredParameters : undefined,
					archiveDir: child.archiveDir, artifactsDir: child.archiveDir ? join(child.archiveDir, "artifacts") : undefined,
					activity: child.activity ? { ...child.activity, elapsedMs: Math.max(0, (child.activity.finishedAt ?? Date.now()) - child.activity.startedAt) } : undefined,
					result: resultPage,
					output: bounded(child.output, outputBytes), error: child.error ? bounded(child.error, 512) : undefined,
				}))) }],
				details,
			};
		},
	});
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_before_switch", () => runtime.shutdown());
	pi.on("session_before_fork", () => runtime.shutdown());
	pi.on("session_before_tree", () => runtime.shutdown());
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => { await runtime.shutdown(); await activeStore?.release(); });
}
