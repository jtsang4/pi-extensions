import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	buildSessionContext,
	createAgentSession,
	defineTool,
	getAgentDir,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ModelRuntime,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BTW_HANDOFF_MESSAGE_TYPE,
	BTW_STATE_ENTRY_TYPE,
	BTW_STATE_VERSION,
	applyBtwEvent,
	createBtwState,
	listBtwThreads,
	reduceBtwState,
	type BtwState,
	type BtwStateEvent,
	type BtwThread,
	type BtwTurn,
} from "./state.ts";

const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const BTW_SYSTEM_PROMPT = `You are working in a persistent BTW side conversation attached to a separate Main Session. The Main Session context is a snapshot for background only; do not continue its unfinished work unless the user asks. You have direct access to the same working directory through Pi's built-in tools, but no other extension tools or extension safety hooks. Avoid workspace changes unless the user intends them. Continue this BTW Thread across follow-up prompts. Call btw_handoff only when the user explicitly asks you to transfer selected content back to the Main Session, and transfer only the requested content with a clear instruction.`;

type AgentMessage = AgentSession["messages"][number];

export type LiveTool = {
	id: string;
	name: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
	running: boolean;
};

export type BtwLiveTurn = {
	threadId: string;
	prompt: string;
	user?: AgentMessage;
	assistant?: AgentMessage;
	tools: LiveTool[];
};

export type BtwRuntimeSnapshot = {
	threads: BtwThread[];
	activeThreadId?: string;
	queuedCount: number;
	live?: BtwLiveTurn;
};

type SideSession = Pick<AgentSession, "abort" | "dispose" | "messages" | "prompt" | "subscribe">;

type SideSessionFactoryInput = {
	ctx: ExtensionCommandContext;
	thread: BtwThread;
	sessionManager: SessionManager;
	handoffTool: ToolDefinition;
	toolNames: string[];
};

export type SideSessionFactory = (input: SideSessionFactoryInput) => Promise<SideSession>;

type QueueJob = {
	threadId: string;
	turnId: string;
	prompt: string;
	ctx: ExtensionCommandContext;
};

type ActiveJob = QueueJob & {
	cancelReason?: string;
	session?: SideSession;
	promise?: Promise<void>;
	turnEntries?: SessionEntry[];
};

type MaterializedThread = {
	manager: SessionManager;
	canonicalByRuntimeId: Map<string, string>;
	persistedEntryCount: number;
};

export type BtwRuntimeOptions = {
	createSession?: SideSessionFactory;
	createId?: () => string;
	now?: () => number;
	onTurnFinished?: (thread: BtwThread, outcome: "completed" | "interrupted") => void;
};

function ensureMainSessionPersistence(manager: unknown): void {
	const internals = manager as {
		flushed: boolean;
		getSessionFile(): string | undefined;
		isPersisted(): boolean;
		_rewriteFile(): void;
	};
	const sessionFile = internals.getSessionFile();
	if (!internals.isPersisted() || !sessionFile || existsSync(sessionFile)) return;
	// ponytail: Pi delays new session files until a Main assistant reply; BTW must persist even when created first.
	if (typeof internals._rewriteFile !== "function") throw new Error("BTW cannot initialize Main Session persistence.");
	internals._rewriteFile();
	internals.flushed = true;
}

function makeTitle(prompt: string): string {
	const firstLine = prompt.trim().split(/\r?\n/, 1)[0] || "Untitled BTW";
	return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
}

function normalizeSeedMessage(message: AgentMessage, now: number): AgentMessage {
	if (message.role === "compactionSummary") {
		return {
			role: "user",
			content: [{ type: "text", text: `[Main Session compaction summary]\n${message.summary}` }],
			timestamp: now,
		} as AgentMessage;
	}
	if (message.role === "branchSummary") {
		return {
			role: "user",
			content: [{ type: "text", text: `[Main Session branch summary]\n${message.summary}` }],
			timestamp: now,
		} as AgentMessage;
	}
	return structuredClone(message);
}

function appendStoredEntry(
	manager: SessionManager,
	entry: SessionEntry,
	canonicalToRuntime: Map<string, string>,
): string | undefined {
	let runtimeId: string | undefined;
	switch (entry.type) {
		case "message":
			runtimeId = manager.appendMessage(structuredClone(entry.message) as Parameters<SessionManager["appendMessage"]>[0]);
			break;
		case "thinking_level_change":
			runtimeId = manager.appendThinkingLevelChange(entry.thinkingLevel);
			break;
		case "model_change":
			runtimeId = manager.appendModelChange(entry.provider, entry.modelId);
			break;
		case "compaction": {
			const firstKept = canonicalToRuntime.get(entry.firstKeptEntryId);
			if (!firstKept) throw new Error(`Cannot restore BTW compaction reference ${entry.firstKeptEntryId}`);
			runtimeId = manager.appendCompaction(
				entry.summary,
				firstKept,
				entry.tokensBefore,
				structuredClone(entry.details),
				entry.fromHook,
				structuredClone(entry.usage),
			);
			break;
		}
		case "custom":
			runtimeId = manager.appendCustomEntry(entry.customType, structuredClone(entry.data));
			break;
		case "custom_message":
			runtimeId = manager.appendCustomMessageEntry(
				entry.customType,
				structuredClone(entry.content),
				entry.display,
				structuredClone(entry.details),
			);
			break;
		case "session_info":
			if (entry.name) runtimeId = manager.appendSessionInfo(entry.name);
			break;
		case "label": {
			const target = canonicalToRuntime.get(entry.targetId);
			if (target) runtimeId = manager.appendLabelChange(target, entry.label);
			break;
		}
		case "branch_summary":
			// BTW Threads never branch internally. Main-branch summaries are normalized in the seed.
			break;
	}
	if (runtimeId) canonicalToRuntime.set(entry.id, runtimeId);
	return runtimeId;
}

// Replayed SessionManagers generate new IDs; canonical maps keep persisted compaction and label references stable.
function materializeThread(thread: BtwThread, cwd: string): MaterializedThread {
	const manager = SessionManager.inMemory(cwd);
	const canonicalToRuntime = new Map<string, string>();
	for (const entry of [...thread.seedEntries, ...thread.entries]) {
		appendStoredEntry(manager, entry, canonicalToRuntime);
	}
	return {
		manager,
		canonicalByRuntimeId: new Map([...canonicalToRuntime].map(([canonical, runtime]) => [runtime, canonical])),
		persistedEntryCount: manager.getEntries().length,
	};
}

function canonicalizeRuntimeEntry(entry: SessionEntry, runtimeToCanonical: Map<string, string>): SessionEntry {
	const copy = structuredClone(entry);
	copy.parentId = copy.parentId ? (runtimeToCanonical.get(copy.parentId) ?? copy.parentId) : null;
	if (copy.type === "compaction") {
		copy.firstKeptEntryId = runtimeToCanonical.get(copy.firstKeptEntryId) ?? copy.firstKeptEntryId;
	} else if (copy.type === "branch_summary") {
		copy.fromId = runtimeToCanonical.get(copy.fromId) ?? copy.fromId;
	} else if (copy.type === "label") {
		copy.targetId = runtimeToCanonical.get(copy.targetId) ?? copy.targetId;
	}
	return copy;
}

function findLastAssistant(messages: readonly AgentMessage[]): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") return messages[index];
	}
	return undefined;
}

export class BtwRuntime {
	private readonly pi: ExtensionAPI;
	private state: BtwState = createBtwState();
	private readonly queue: QueueJob[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly createSession: SideSessionFactory;
	private readonly createId: () => string;
	private readonly now: () => number;
	private readonly onTurnFinished?: BtwRuntimeOptions["onTurnFinished"];
	private active?: ActiveJob;
	private live?: BtwLiveTurn;
	private suspended = false;

	constructor(pi: ExtensionAPI, options: BtwRuntimeOptions = {}) {
		this.pi = pi;
		this.createSession = options.createSession ?? ((input) => this.createProductionSession(input));
		this.createId = options.createId ?? randomUUID;
		this.now = options.now ?? Date.now;
		this.onTurnFinished = options.onTurnFinished;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	getSnapshot(): BtwRuntimeSnapshot {
		return {
			threads: listBtwThreads(this.state),
			activeThreadId: this.active?.threadId,
			queuedCount: this.queue.length,
			live: this.live ? structuredClone(this.live) : undefined,
		};
	}

	getThread(threadId: string): BtwThread | undefined {
		return this.state.threads.get(threadId);
	}

	restore(entries: readonly SessionEntry[]): void {
		this.state = reduceBtwState(entries, true);
		this.queue.length = 0;
		this.active = undefined;
		this.live = undefined;
		this.suspended = false;
		this.emit();
	}

	private append(event: BtwStateEvent): void {
		this.pi.appendEntry(BTW_STATE_ENTRY_TYPE, structuredClone(event));
		applyBtwEvent(this.state, event);
		this.emit();
	}

	createThread(prompt: string, ctx: ExtensionCommandContext): BtwThread {
		const question = prompt.trim();
		if (!question) throw new Error("BTW requires a question.");
		if (!ctx.model) throw new Error("No model selected for BTW.");

		const now = this.now();
		const seedManager = SessionManager.inMemory(ctx.cwd);
		const mainMessages = buildSessionContext(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId()).messages;
		for (const message of mainMessages) {
			seedManager.appendMessage(normalizeSeedMessage(message, now) as Parameters<SessionManager["appendMessage"]>[0]);
		}

		ensureMainSessionPersistence(ctx.sessionManager);
		const thread: BtwThread = {
			id: this.createId(),
			title: makeTitle(question),
			createdAt: now,
			updatedAt: now,
			model: { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api },
			thinkingLevel: ctx.thinkingLevel ?? this.pi.getThinkingLevel(),
			seedEntries: seedManager.getEntries(),
			entries: [],
			turns: [],
			status: "idle",
		};
		this.append({
			version: BTW_STATE_VERSION,
			kind: "thread_created",
			at: now,
			thread: {
				id: thread.id,
				title: thread.title,
				createdAt: thread.createdAt,
				updatedAt: thread.updatedAt,
				model: thread.model,
				thinkingLevel: thread.thinkingLevel,
				seedEntries: thread.seedEntries,
			},
		});
		this.enqueue(thread.id, question, ctx);
		return this.state.threads.get(thread.id)!;
	}

	enqueueFollowUp(threadId: string, prompt: string, ctx: ExtensionCommandContext): void {
		if (!this.state.threads.has(threadId)) throw new Error("Unknown BTW Thread.");
		const question = prompt.trim();
		if (!question) throw new Error("BTW requires a question.");
		this.enqueue(threadId, question, ctx);
	}

	private enqueue(threadId: string, prompt: string, ctx: ExtensionCommandContext): void {
		const now = this.now();
		const turn: BtwTurn = {
			id: this.createId(),
			prompt,
			status: "queued",
			createdAt: now,
			updatedAt: now,
		};
		this.append({ version: BTW_STATE_VERSION, kind: "turn_queued", at: now, threadId, turn });
		this.queue.push({ threadId, turnId: turn.id, prompt, ctx });
		this.pump();
	}

	resumePaused(threadId: string, ctx: ExtensionCommandContext): number {
		const thread = this.state.threads.get(threadId);
		if (!thread) return 0;
		const paused = thread.turns.filter((turn) => turn.status === "paused");
		for (const turn of paused) {
			const now = this.now();
			this.append({
				version: BTW_STATE_VERSION,
				kind: "turn_queued",
				at: now,
				threadId,
				turn: { id: turn.id, prompt: turn.prompt, createdAt: turn.createdAt, updatedAt: now },
			});
			this.queue.push({ threadId, turnId: turn.id, prompt: turn.prompt, ctx });
		}
		this.pump();
		return paused.length;
	}

	private pump(): void {
		if (this.suspended || this.active || this.queue.length === 0) return;
		const job = this.queue.shift()!;
		const active: ActiveJob = { ...job };
		this.active = active;
		active.promise = this.runTurn(active).finally(() => {
			if (this.active === active) this.active = undefined;
			this.live = undefined;
			this.emit();
			this.pump();
		});
	}

	private createHandoffTool(thread: BtwThread, ctx: ExtensionCommandContext): ToolDefinition {
		const pi = this.pi;
		return defineTool({
			name: "btw_handoff",
			label: "BTW Handoff",
			description: "Transfer user-selected content and instructions from this BTW Thread to the Main Session",
			promptSnippet: "Transfer explicitly requested BTW content to the Main Session",
			promptGuidelines: [
				"Call btw_handoff only after the user explicitly asks to transfer specific BTW content to the Main Session.",
			],
			executionMode: "sequential",
			parameters: Type.Object({
				content: Type.String({ description: "Only the BTW content the user asked to transfer" }),
				instruction: Type.String({ description: "How the Main Session should use the transferred content" }),
			}),
			execute: async (_toolCallId, params) => {
				const content = `[BTW handoff: ${thread.title}]\n\n${params.content}\n\nInstruction: ${params.instruction}`;
				const options = ctx.isIdle()
					? { triggerTurn: true as const }
					: { triggerTurn: true as const, deliverAs: "followUp" as const };
				pi.sendMessage(
					{
						customType: BTW_HANDOFF_MESSAGE_TYPE,
						content,
						display: true,
						details: { threadId: thread.id, title: thread.title, instruction: params.instruction },
					},
					options,
				);
				return {
					content: [{ type: "text", text: "Transferred the requested content to the Main Session." }],
					details: { threadId: thread.id },
				};
			},
		});
	}

	private async createProductionSession(input: SideSessionFactoryInput): Promise<SideSession> {
		const model = input.ctx.modelRegistry.find(input.thread.model.provider, input.thread.model.id);
		if (!model) throw new Error(`BTW model is unavailable: ${input.thread.model.provider}/${input.thread.model.id}`);
		const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		// ponytail: ModelRegistry has no public runtime getter; reuse it so in-memory OAuth and registered providers stay exact.
		const modelRuntime = (input.ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
		if (!modelRuntime) throw new Error("BTW cannot access the active model runtime.");
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(input.ctx.cwd, agentDir, {
			projectTrusted: input.ctx.isProjectTrusted(),
		});
		const loader = new DefaultResourceLoader({
			cwd: input.ctx.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			appendSystemPromptOverride: (base) => [...base, BTW_SYSTEM_PROMPT],
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: input.ctx.cwd,
			model,
			modelRuntime,
			thinkingLevel: input.thread.thinkingLevel,
			sessionManager: input.sessionManager,
			settingsManager,
			resourceLoader: loader,
			tools: [...input.toolNames, "btw_handoff"],
			customTools: [input.handoffTool],
		});
		return session;
	}

	private handleSessionEvent(active: ActiveJob, materialized: MaterializedThread, event: AgentSessionEvent): void {
		if (this.active !== active || !this.live) return;
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			if (event.message.role === "user") this.live.user = structuredClone(event.message);
			else if (event.message.role === "assistant") this.live.assistant = structuredClone(event.message);
		} else if (event.type === "tool_execution_start") {
			this.live.tools.push({
				id: event.toolCallId,
				name: event.toolName,
				args: structuredClone(event.args),
				running: true,
			});
		} else if (event.type === "tool_execution_end") {
			const tool = this.live.tools.find((candidate) => candidate.id === event.toolCallId);
			if (tool) {
				tool.result = structuredClone(event.result);
				tool.isError = event.isError;
				tool.running = false;
			}
		}
		if (event.type === "message_end") {
			// AgentSession emits message_end immediately before SessionManager appends it.
			queueMicrotask(() => {
				if (this.active === active) active.turnEntries?.push(...this.syncEntries(active.threadId, materialized));
			});
		} else if (event.type === "compaction_end" && !event.aborted) {
			active.turnEntries?.push(...this.syncEntries(active.threadId, materialized));
		}
		this.emit();
	}

	private syncEntries(threadId: string, materialized: MaterializedThread): SessionEntry[] {
		// ponytail: threads are expected to stay small; switch to an append callback if getEntries() scans become measurable.
		const entries = materialized.manager.getEntries();
		const appended: SessionEntry[] = [];
		for (const runtimeEntry of entries.slice(materialized.persistedEntryCount)) {
			const canonical = canonicalizeRuntimeEntry(runtimeEntry, materialized.canonicalByRuntimeId);
			materialized.canonicalByRuntimeId.set(runtimeEntry.id, canonical.id);
			appended.push(canonical);
			this.append({
				version: BTW_STATE_VERSION,
				kind: "entry_appended",
				at: this.now(),
				threadId,
				entry: canonical,
			});
		}
		materialized.persistedEntryCount = entries.length;
		return appended;
	}

	private async runTurn(active: ActiveJob): Promise<void> {
		const thread = this.state.threads.get(active.threadId);
		if (!thread) return;
		this.append({
			version: BTW_STATE_VERSION,
			kind: "turn_started",
			at: this.now(),
			threadId: active.threadId,
			turnId: active.turnId,
		});
		this.live = { threadId: active.threadId, prompt: active.prompt, tools: [] };
		this.emit();

		let materialized: MaterializedThread | undefined;
		let unsubscribe: (() => void) | undefined;
		let outcome: "completed" | "interrupted" = "interrupted";
		try {
			materialized = materializeThread(thread, active.ctx.cwd);
			const builtins = this.pi
				.getAllTools()
				.filter((tool) => tool.sourceInfo.source === "builtin")
				.map((tool) => tool.name);
			const toolNames = builtins.length > 0 ? builtins : [...BUILTIN_TOOL_NAMES];
			const session = await this.createSession({
				ctx: active.ctx,
				thread,
				sessionManager: materialized.manager,
				handoffTool: this.createHandoffTool(thread, active.ctx),
				toolNames,
			});
			active.session = session;
			active.turnEntries = [];
			unsubscribe = session.subscribe((event) => this.handleSessionEvent(active, materialized!, event));
			const messageCountBefore = session.messages.length;
			if (active.cancelReason) await session.abort();
			else await session.prompt(active.prompt, { source: "extension" });
			// Keep incrementally synced entries: compaction may remove the final assistant from session.messages.
			const appended = [...active.turnEntries, ...this.syncEntries(active.threadId, materialized)];

			const assistantEntry = [...appended].reverse().find(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			const assistant = assistantEntry?.type === "message" ? assistantEntry.message : findLastAssistant(session.messages.slice(messageCountBefore));
			const stopReason = assistant?.role === "assistant" ? assistant.stopReason : undefined;
			if (active.cancelReason || stopReason === "aborted" || stopReason === "error") {
				this.append({
					version: BTW_STATE_VERSION,
					kind: "turn_interrupted",
					at: this.now(),
					threadId: active.threadId,
					turnId: active.turnId,
					reason:
						active.cancelReason ??
						(assistant?.role === "assistant" ? assistant.errorMessage : undefined) ??
						"BTW turn was interrupted.",
				});
			} else {
				outcome = "completed";
				this.append({
					version: BTW_STATE_VERSION,
					kind: "turn_completed",
					at: this.now(),
					threadId: active.threadId,
					turnId: active.turnId,
				});
			}
		} catch (error) {
			if (materialized) this.syncEntries(active.threadId, materialized);
			this.append({
				version: BTW_STATE_VERSION,
				kind: "turn_interrupted",
				at: this.now(),
				threadId: active.threadId,
				turnId: active.turnId,
				reason: error instanceof Error ? error.message : String(error),
			});
		} finally {
			unsubscribe?.();
			active.session?.dispose();
			const latest = this.state.threads.get(active.threadId);
			if (latest) this.onTurnFinished?.(latest, outcome);
		}
	}

	async cancelActive(reason = "Cancelled by the user."): Promise<boolean> {
		const active = this.active;
		if (!active) return false;
		active.cancelReason ??= reason;
		await active.session?.abort();
		await active.promise;
		return true;
	}

	async suspend(reason: string): Promise<void> {
		this.suspended = true;
		await this.cancelActive(reason);
		for (const job of this.queue.splice(0)) {
			this.append({
				version: BTW_STATE_VERSION,
				kind: "turn_paused",
				at: this.now(),
				threadId: job.threadId,
				turnId: job.turnId,
				reason,
			});
		}
	}

	async shutdown(reason: string): Promise<void> {
		await this.suspend(reason);
		this.listeners.clear();
	}
}
