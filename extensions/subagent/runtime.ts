import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { truncateTail, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ArchiveRef, ResultPage, RunArchive, StorageContext } from "./storage.ts";

export type ChildSession = Pick<AgentSession, "messages" | "isStreaming" | "prompt" | "steer" | "abort" | "dispose" | "subscribe">;
export type History = AgentSession["messages"];
export type Activity = {
	startedAt: number;
	finishedAt?: number;
	lastActivityAt: number;
	modelTurns: number;
	toolCalls: number;
	lastTool?: string;
	queuedMessages: number;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
};
export type Child = {
	id: string;
	task: string;
	role: "scout" | "worker";
	model: { provider: string; id: string };
	thinking: string;
	tools: string[];
	status: "running" | "completed" | "failed" | "stopped";
	output: string;
	error?: string;
	history: History;
	resumable: boolean;
	turn: number;
	timeoutMs: number;
	maxTurns: number;
	archive?: ArchiveRef;
	checkpoint?: ArchiveRef;
	archiveDir?: string;
	activity?: Activity;
};
export type Snapshot = { version: 1 | 2; children: Child[] };
type Run = { child: Child; session?: ChildSession; done: Promise<void>; reason?: string; cancelStart?: () => void; settling?: boolean };
export type Factory = (child: Child) => Promise<ChildSession>;

export function bounded(text: string, maxBytes = 16_384): string {
	const result = truncateTail(text, { maxBytes, maxLines: 400 });
	return result.truncated ? `[Earlier output truncated]\n${result.content}` : result.content;
}

async function beforeSend(done: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return done;
	let cancel!: () => void;
	try {
		await Promise.race([done, new Promise<never>((_resolve, reject) => {
			cancel = () => reject(new Error("Send cancelled; the message was not delivered."));
			if (signal.aborted) cancel();
			else signal.addEventListener("abort", cancel, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", cancel); }
}

/** Live handles never enter persistence. Tool results checkpoint the active branch. */
export class SubagentRuntime {
	private children = new Map<string, Child>();
	private runs = new Map<string, Run>();
	private starting = new Set<Run>();
	private closing = false;
	private storage?: StorageContext;

	snapshot(): Snapshot {
		return { version: 2, children: structuredClone([...this.children.values()].map((child) =>
			child.checkpoint ? { ...child, history: [], output: bounded(child.output, 2048) } : child)) };
	}

	async restore(entries: readonly SessionEntry[], storage?: StorageContext): Promise<void> {
		if (this.runs.size) throw new Error("Stop subagents before restoring a branch.");
		this.storage = storage;
		let snapshot: Snapshot = { version: 1, children: [] };
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "pi_subagent" || entry.message.isError) continue;
			const details = entry.message.details as Snapshot | undefined;
			if ((details?.version === 1 || details?.version === 2) && Array.isArray(details.children)) snapshot = details;
		}
		const children = structuredClone(snapshot.children);
		for (const child of children) {
			if (child.checkpoint) {
				try {
					if (!storage) throw new Error("Archive access is disabled for an ephemeral parent session.");
					if (child.checkpoint.childId !== child.id) throw new Error("Checkpoint belongs to a different child.");
					await storage.store.checkHistory(child.checkpoint);
					child.history = []; // Load the body only if this particular child is continued.
					child.resumable = true;
				} catch (error) {
					child.history = [];
					child.resumable = false;
					child.error = bounded(`Cannot restore subagent checkpoint: ${String(error)}. Read the archived result or spawn a new child with a summary.`, 2048);
				}
			}
			if (child.status === "running") {
				child.status = "stopped";
				if (child.activity) child.activity.finishedAt ??= child.activity.lastActivityAt;
				child.error ??= "Runtime ended before this turn was checkpointed. Send a new task to continue from the last checkpoint; uncollected results may be in archiveDir.";
			}
			if (storage && child.archive) {
				try { child.archiveDir = storage.store.path(child.archive); }
				catch {
					delete child.archiveDir;
					child.resumable = false;
					child.error = "Invalid subagent archive reference; spawn a new child with a summary.";
				}
			}
		}
		this.children = new Map(children.map((child) => [child.id, child]));
		this.closing = false;
	}

	setBranch(branchId: string | null): void { if (this.storage) this.storage = { ...this.storage, branchId }; }

	get(id: string): Child {
		const child = this.children.get(id);
		if (!child) throw new Error(`Unknown subagent: ${id}`);
		return child;
	}

	forget(id: string): void {
		this.get(id);
		if (this.runs.has(id)) throw new Error("Stop the subagent and wait for cleanup before forgetting it.");
		this.children.delete(id);
	}

	async result(id: string, offset = 0): Promise<ResultPage> {
		const child = this.get(id);
		if (!child.archive || !this.storage) throw new Error("This child has no archive; wait/list provide its bounded summary.");
		if (this.runs.has(id)) throw new Error("The subagent report is still being written; wait for it to finish.");
		return this.storage.store.readResult(child.archive, offset);
	}

	spawn(input: Omit<Child, "id" | "status" | "output" | "history" | "resumable" | "turn">, factory: Factory): string {
		if (this.children.size >= 32) throw new Error("At most 32 subagents per branch; reuse an existing child with send.");
		this.checkCapacity();
		const child: Child = { ...input, id: randomUUID(), status: "running", output: "", history: [], resumable: true, turn: 0 };
		this.children.set(child.id, child);
		this.start(child, input.task, factory);
		return child.id;
	}

	private checkCapacity(): void {
		if (this.closing) throw new Error("Subagents are shutting down.");
		if (new Set([...this.runs.values(), ...this.starting]).size >= 4) throw new Error("Four subagents are running or initializing. Wait for cleanup or stop one before starting more.");
	}

	async send(id: string, message: string, factory: Factory, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Send cancelled; the message was not delivered.");
		const child = this.get(id);
		const run = this.runs.get(id);
		if (run) {
			if (run.settling) { await beforeSend(run.done, signal); return this.send(id, message, factory, signal); }
			if (!run.session || run.reason) throw new Error("Subagent is starting or stopping; wait before sending.");
			if (!run.session.isStreaming) {
				await beforeSend(run.done, signal); // Do not queue into a session that will be disposed.
				return this.send(id, message, factory, signal);
			}
			await run.session.steer(message);
			return;
		}
		if (!child.resumable) throw new Error("Child checkpoint is unavailable or exceeded the checkpoint limit; spawn a new child with a summary.");
		this.checkCapacity();
		this.start(child, message, factory);
	}

	private start(child: Child, task: string, factory: Factory): void {
		child.status = "running";
		child.error = undefined;
		child.output = "";
		child.task = task;
		child.turn++;
		child.activity = { startedAt: Date.now(), lastActivityAt: Date.now(), modelTurns: 0, toolCalls: 0, queuedMessages: 0 };
		if (this.storage) {
			child.archive = { parentId: this.storage.parentId, childId: child.id, runId: randomUUID() };
			child.archiveDir = this.storage.store.path(child.archive);
		} else {
			delete child.archive;
			delete child.archiveDir;
		}
		const run: Run = { child, done: Promise.resolve() };
		this.runs.set(child.id, run); // Reserve synchronously, including session initialization.
		run.done = this.execute(run, task, factory);
	}

	private async execute(run: Run, task: string, factory: Factory): Promise<void> {
		const child = run.child;
		const storage = this.storage;
		let archive: RunArchive | undefined;
		let fullOutput = "";
		let streamingMessage: History[number] | undefined;
		let lastPreviewAt = 0;
		let unsubscribe: (() => void) | undefined;
		const stop = (reason: string) => {
			run.reason ??= reason;
			run.cancelStart?.();
			void run.session?.abort().catch(() => {});
		};
		const timer = setTimeout(() => stop("Subagent turn timed out."), child.timeoutMs);
		try {
			if (storage && child.archive) archive = await storage.store.begin(child.archive, storage, child, task);
			if (run.reason) return;
			this.starting.add(run);
			const creating = Promise.resolve().then(async () => {
				if (run.reason) throw new Error(run.reason);
				const prepared = structuredClone(child);
				if (child.checkpoint && storage) {
					try { prepared.history = await storage.store.readHistory(child.checkpoint); }
					catch (error) { child.resumable = false; throw new Error(`Cannot restore subagent checkpoint: ${String(error)}`); }
				}
				if (run.reason) throw new Error(run.reason);
				return factory(prepared);
			});
			// A stop must not wait indefinitely for initialization. Dispose a late arrival.
			void creating.then((session) => {
				this.starting.delete(run);
				if (run.reason && !run.session) session.dispose();
			}, () => { this.starting.delete(run); }).catch(() => {});
			const session = await Promise.race([
				creating,
				new Promise<never>((_resolve, reject) => { run.cancelStart = () => reject(new Error(run.reason)); }),
			]);
			run.cancelStart = undefined;
			run.session = session;
			if (run.reason) return;
			let turns = 0;
			let final: History[number] | undefined;
			unsubscribe = session.subscribe((event) => {
				archive?.record(event);
				const activity = child.activity!;
				activity.lastActivityAt = Date.now();
				if (event.type === "queue_update") activity.queuedMessages = event.steering.length + event.followUp.length;
				if (event.type === "tool_execution_start") { activity.toolCalls++; activity.lastTool = event.toolName; }
				if (event.type === "message_update" && event.message.role === "assistant") {
					streamingMessage = event.message;
					if (Date.now() - lastPreviewAt >= 500) {
						const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
						if (text.trim()) { fullOutput = text; child.output = bounded(text); }
						lastPreviewAt = Date.now();
					}
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					final = event.message;
					streamingMessage = undefined;
					activity.modelTurns++;
					const usage = event.message.usage;
					if (usage) {
						activity.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
						for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) activity.usage[key] += usage[key];
						activity.usage.cost += usage.cost.total;
					}
					const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					if (text.trim()) fullOutput = text;
					child.output = bounded(fullOutput);
				}
				if (event.type === "turn_end" && ++turns >= child.maxTurns && event.message.role === "assistant" && event.message.stopReason === "toolUse") stop("Subagent model-turn limit reached.");
			});
			const prompt = child.archiveDir ? `${task}\n\n[Subagent run context]\nArchive directory: ${JSON.stringify(child.archiveDir)}\nArtifacts directory: ${JSON.stringify(join(child.archiveDir, "artifacts"))}\nUse this run's artifacts directory for temporary reports and test logs. Keep project deliverables in their requested paths; leave previous run archives unchanged.` : task;
			await session.prompt(prompt, { source: "extension", expandPromptTemplates: false });
			if (final?.role !== "assistant") throw new Error("Subagent produced no terminal assistant message.");
			child.output = bounded(fullOutput);
			if (final.stopReason !== "stop") throw new Error(final.errorMessage || `Subagent ended with ${final.stopReason}.`);
			if (!fullOutput.trim()) throw new Error("Subagent ended without a textual report; inspect its artifacts before relying on the task outcome.");
			child.status = "completed";
		} catch (error) {
			child.status = "failed";
			child.error = bounded(error instanceof Error ? error.message : String(error), 2048);
		} finally {
			run.settling = true;
			if (streamingMessage?.role === "assistant") {
				const text = streamingMessage.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				if (text.trim()) fullOutput = text;
			}
			child.output = bounded(fullOutput);
			clearTimeout(timer);
			unsubscribe?.();
			const previousHistory = child.history;
			const hadSession = !!run.session;
			let cleanupError: string | undefined;
			if (run.session) {
				// AgentSession.messages is the compacted, protocol-valid continuation context.
				const history = structuredClone(run.session.messages);
				child.resumable = !!archive || Buffer.byteLength(JSON.stringify(history)) <= 2_000_000;
				child.history = child.resumable ? history : [];
				try { run.session.dispose(); }
				catch (error) { cleanupError = bounded(`Cleanup failed: ${String(error)}`, 2048); }
				finally { run.session = undefined; }
			}
			if (run.reason) { child.status = "stopped"; child.error = run.reason; }
			if (child.activity!.queuedMessages) {
				if (child.status === "completed") child.status = "failed";
				child.error = [child.error, `${child.activity!.queuedMessages} queued message(s) were not delivered; resend explicitly if still needed.`].filter(Boolean).join("\n");
			}
			if (cleanupError) { child.status = "failed"; child.error = [child.error, cleanupError].filter(Boolean).join("\n"); }
			child.activity!.finishedAt = Date.now();
			if (archive && child.archive) {
				const terminal = structuredClone(child);
				child.status = "running"; // Keep the slot/status live until all archive writes settle.
				child.history = previousHistory; // Polls must still checkpoint the previous collected context.
				try {
					await archive.finish(terminal, fullOutput || terminal.error || "", hadSession);
					if (hadSession) child.checkpoint = child.archive;
					child.history = child.checkpoint ? [] : terminal.history;
					child.status = terminal.status;
				} catch (error) {
					child.status = "failed";
					child.error = bounded([terminal.error, `Subagent archive failed: ${String(error)}`].filter(Boolean).join("\n"), 2048);
					if (hadSession) {
						delete child.checkpoint;
						child.history = terminal.history;
						child.resumable = Buffer.byteLength(JSON.stringify(child.history)) <= 2_000_000;
						if (!child.resumable) child.history = [];
					}
				}
			}
			this.runs.delete(child.id);
		}
	}

	async wait(ids: string[], timeoutMs: number, signal?: AbortSignal, waitFor: "all" | "any" = "all"): Promise<void> {
		ids.forEach((id) => this.get(id));
		if (signal?.aborted) throw new Error("Wait cancelled; children continue running.");
		const pending = ids.map((id) => this.runs.get(id)?.done).filter((done) => done !== undefined);
		if (pending.length === 0) return;
		if (waitFor === "any" && ids.some((id) => !this.runs.has(id))) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel: () => void = () => {};
		try {
			await Promise.race([
				waitFor === "any" ? Promise.race(pending) : Promise.all(pending),
				new Promise<void>((resolve, reject) => {
					timer = setTimeout(resolve, timeoutMs);
					cancel = () => reject(new Error("Wait cancelled; children continue running."));
					signal?.addEventListener("abort", cancel, { once: true });
				}),
			]);
		} finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
	}

	async stop(id: string, reason = "Stopped by parent."): Promise<void> {
		this.get(id);
		const run = this.runs.get(id);
		if (!run) return;
		if (run.settling) { await run.done; return; }
		run.reason ??= reason;
		run.cancelStart?.();
		try { await run.session?.abort(); }
		finally { await run.done; }
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		try { await Promise.all([...this.runs.keys()].map((id) => this.stop(id, "Parent session closed or changed branch."))); }
		finally { this.closing = false; } // A later extension may veto navigation.
	}
}
