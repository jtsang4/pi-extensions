import { randomUUID } from "node:crypto";
import { truncateTail, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ArchiveRef, RunArchive, StorageContext } from "./storage.ts";

export type ChildSession = Pick<AgentSession, "messages" | "isStreaming" | "prompt" | "steer" | "abort" | "dispose" | "subscribe">;
export type History = AgentSession["messages"];
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
};
export type Snapshot = { version: 1 | 2; children: Child[] };
type Run = { child: Child; session?: ChildSession; done: Promise<void>; reason?: string; cancelStart?: () => void };
export type Factory = (child: Child) => Promise<ChildSession>;

export function bounded(text: string, maxBytes = 16_384): string {
	const result = truncateTail(text, { maxBytes, maxLines: 400 });
	return result.truncated ? `[Earlier output truncated]\n${result.content}` : result.content;
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
			child.checkpoint ? { ...child, history: [] } : child)) };
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
					child.history = await storage.store.readHistory(child.checkpoint);
					child.resumable = true;
				} catch (error) {
					child.history = [];
					child.resumable = false;
					child.error = bounded(`Cannot restore subagent checkpoint: ${String(error)}. Read the archived result or spawn a new child with a summary.`, 2048);
				}
			}
			if (child.status === "running") {
				child.status = "stopped";
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

	async send(id: string, message: string, factory: Factory): Promise<void> {
		const child = this.get(id);
		const run = this.runs.get(id);
		if (run) {
			if (!run.session || run.reason) throw new Error("Subagent is starting or stopping; wait before sending.");
			if (!run.session.isStreaming) {
				await run.done; // Closing-turn race: do not put a message into a queue that will be disposed.
				return this.send(id, message, factory);
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
		child.turn++;
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
			const creating = Promise.resolve().then(() => {
				if (run.reason) throw new Error(run.reason);
				return factory(structuredClone(child));
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
				if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
				if (event.type === "turn_end" && ++turns >= child.maxTurns && event.message.role === "assistant" && event.message.stopReason === "toolUse") stop("Subagent model-turn limit reached.");
			});
			await session.prompt(task, { source: "extension", expandPromptTemplates: false });
			if (final?.role !== "assistant") throw new Error("Subagent produced no terminal assistant message.");
			fullOutput = final.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			child.output = bounded(fullOutput);
			if (final.stopReason !== "stop") throw new Error(final.errorMessage || `Subagent ended with ${final.stopReason}.`);
			child.status = "completed";
		} catch (error) {
			child.status = "failed";
			child.error = bounded(error instanceof Error ? error.message : String(error), 2048);
		} finally {
			clearTimeout(timer);
			unsubscribe?.();
			const previousHistory = child.history;
			let cleanupError: string | undefined;
			if (run.session) {
				// AgentSession.messages is the compacted, protocol-valid continuation context.
				const history = structuredClone(run.session.messages);
				child.resumable = !!archive || Buffer.byteLength(JSON.stringify(history)) <= 2_000_000;
				child.history = child.resumable ? history : [];
				try { run.session.dispose(); }
				catch (error) { cleanupError = bounded(`Cleanup failed: ${String(error)}`, 2048); }
			}
			if (run.reason) { child.status = "stopped"; child.error = run.reason; }
			if (cleanupError) { child.status = "failed"; child.error = [child.error, cleanupError].filter(Boolean).join("\n"); }
			if (archive && child.archive) {
				const terminal = structuredClone(child);
				child.status = "running"; // Keep the slot/status live until all archive writes settle.
				child.history = previousHistory; // Polls must still checkpoint the previous collected context.
				try {
					await archive.finish(terminal, fullOutput || terminal.error || "");
					child.checkpoint = child.archive;
					child.history = terminal.history;
					child.status = terminal.status;
				} catch (error) {
					delete child.checkpoint;
					child.status = "failed";
					child.error = bounded([terminal.error, `Subagent archive failed: ${String(error)}`].filter(Boolean).join("\n"), 2048);
					child.history = terminal.history;
					child.resumable = Buffer.byteLength(JSON.stringify(child.history)) <= 2_000_000;
					if (!child.resumable) child.history = [];
				}
			}
			this.runs.delete(child.id);
		}
	}

	async wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
		ids.forEach((id) => this.get(id));
		if (signal?.aborted) throw new Error("Wait cancelled; children continue running.");
		const pending = ids.map((id) => this.runs.get(id)?.done).filter((done) => done !== undefined);
		if (pending.length === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel: () => void = () => {};
		try {
			await Promise.race([
				Promise.all(pending),
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
