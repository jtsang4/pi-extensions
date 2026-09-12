import { randomUUID } from "node:crypto";
import { truncateTail, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";

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
};
export type Snapshot = { version: 1; children: Child[] };
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

	snapshot(): Snapshot {
		return { version: 1, children: structuredClone([...this.children.values()]) };
	}

	restore(entries: readonly SessionEntry[]): void {
		if (this.runs.size) throw new Error("Stop subagents before restoring a branch.");
		let snapshot: Snapshot = { version: 1, children: [] };
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "pi_subagent" || entry.message.isError) continue;
			const details = entry.message.details as Snapshot | undefined;
			if (details?.version === 1 && Array.isArray(details.children)) snapshot = details;
		}
		this.children = new Map(structuredClone(snapshot.children).map((child) => {
			if (child.status === "running") {
				child.status = "stopped";
				child.error = "Runtime ended before this turn was checkpointed. Send a new task to continue from the last checkpoint.";
			}
			return [child.id, child];
		}));
		this.closing = false;
	}

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
		if (!child.resumable) throw new Error("Child context exceeded the checkpoint limit; spawn a new child with a summary.");
		this.checkCapacity();
		this.start(child, message, factory);
	}

	private start(child: Child, task: string, factory: Factory): void {
		child.status = "running";
		child.error = undefined;
		child.output = "";
		child.turn++;
		const run: Run = { child, done: Promise.resolve() };
		this.runs.set(child.id, run); // Reserve synchronously, including session initialization.
		run.done = this.execute(run, task, factory);
	}

	private async execute(run: Run, task: string, factory: Factory): Promise<void> {
		const child = run.child;
		let unsubscribe: (() => void) | undefined;
		const stop = (reason: string) => {
			run.reason ??= reason;
			run.cancelStart?.();
			void run.session?.abort().catch(() => {});
		};
		const timer = setTimeout(() => stop("Subagent turn timed out."), child.timeoutMs);
		try {
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
				if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
				if (event.type === "turn_end" && ++turns >= child.maxTurns && event.message.role === "assistant" && event.message.stopReason === "toolUse") stop("Subagent model-turn limit reached.");
			});
			await session.prompt(task, { source: "extension", expandPromptTemplates: false });
			if (final?.role !== "assistant") throw new Error("Subagent produced no terminal assistant message.");
			child.output = bounded(final.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
			if (final.stopReason !== "stop") throw new Error(final.errorMessage || `Subagent ended with ${final.stopReason}.`);
			child.status = "completed";
		} catch (error) {
			child.status = "failed";
			child.error = bounded(error instanceof Error ? error.message : String(error), 2048);
		} finally {
			clearTimeout(timer);
			unsubscribe?.();
			let cleanupError: string | undefined;
			if (run.session) {
				// AgentSession.messages is the compacted, protocol-valid continuation context.
				const history = structuredClone(run.session.messages);
				child.resumable = Buffer.byteLength(JSON.stringify(history)) <= 2_000_000;
				child.history = child.resumable ? history : [];
				try { run.session.dispose(); }
				catch (error) { cleanupError = bounded(`Cleanup failed: ${String(error)}`, 2048); }
			}
			if (run.reason) { child.status = "stopped"; child.error = run.reason; }
			if (cleanupError) { child.status = "failed"; child.error = [child.error, cleanupError].filter(Boolean).join("\n"); }
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
