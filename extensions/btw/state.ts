import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";

export const BTW_STATE_ENTRY_TYPE = "jtsang4-btw-state";
export const BTW_HANDOFF_MESSAGE_TYPE = "jtsang4-btw-handoff";
// Persisted in Main Session JSONL; bump only together with reducer compatibility or migration.
export const BTW_STATE_VERSION = 1;

export type BtwThreadStatus = "queued" | "running" | "idle" | "paused" | "interrupted";
export type BtwTurnStatus = "queued" | "running" | "completed" | "paused" | "interrupted";
export type BtwThinkingLevel = AgentSession["thinkingLevel"];

export type BtwModelRef = {
	provider: string;
	id: string;
	api: string;
};

export type BtwTurn = {
	id: string;
	prompt: string;
	status: BtwTurnStatus;
	createdAt: number;
	updatedAt: number;
	reason?: string;
};

export type BtwThread = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	model: BtwModelRef;
	thinkingLevel: BtwThinkingLevel;
	seedEntries: SessionEntry[];
	entries: SessionEntry[];
	turns: BtwTurn[];
	status: BtwThreadStatus;
};

export type BtwState = {
	threads: Map<string, BtwThread>;
};

type EventBase = {
	version: typeof BTW_STATE_VERSION;
	at: number;
};

export type BtwStateEvent =
	| (EventBase & {
		kind: "thread_created";
		thread: Pick<
			BtwThread,
			"id" | "title" | "createdAt" | "updatedAt" | "model" | "thinkingLevel" | "seedEntries"
		>;
	})
	| (EventBase & {
		kind: "turn_queued";
		threadId: string;
		turn: Pick<BtwTurn, "id" | "prompt" | "createdAt" | "updatedAt">;
	})
	| (EventBase & { kind: "turn_started"; threadId: string; turnId: string })
	| (EventBase & { kind: "turn_completed"; threadId: string; turnId: string })
	| (EventBase & { kind: "turn_paused"; threadId: string; turnId: string; reason?: string })
	| (EventBase & { kind: "turn_interrupted"; threadId: string; turnId: string; reason?: string })
	| (EventBase & { kind: "entry_appended"; threadId: string; entry: SessionEntry });

export function createBtwState(): BtwState {
	return { threads: new Map() };
}

function deriveThreadStatus(thread: BtwThread): BtwThreadStatus {
	if (thread.turns.some((turn) => turn.status === "running")) return "running";
	if (thread.turns.some((turn) => turn.status === "queued")) return "queued";
	if (thread.turns.some((turn) => turn.status === "paused")) return "paused";
	return thread.turns.at(-1)?.status === "interrupted" ? "interrupted" : "idle";
}

function updateTurn(
	thread: BtwThread,
	turnId: string,
	status: BtwTurnStatus,
	at: number,
	reason?: string,
): void {
	const turn = thread.turns.find((candidate) => candidate.id === turnId);
	if (!turn) return;
	turn.status = status;
	turn.updatedAt = at;
	turn.reason = reason;
	thread.updatedAt = at;
	thread.status = deriveThreadStatus(thread);
}

function hasKnownReferences(entry: SessionEntry, knownIds: ReadonlySet<string>): boolean {
	if (entry.parentId && !knownIds.has(entry.parentId)) return false;
	if (entry.type === "compaction") return knownIds.has(entry.firstKeptEntryId);
	if (entry.type === "branch_summary") return knownIds.has(entry.fromId);
	if (entry.type === "label") return knownIds.has(entry.targetId);
	return true;
}

function entriesHaveValidReferences(entries: readonly SessionEntry[], initialIds: readonly string[] = []): boolean {
	const knownIds = new Set(initialIds);
	for (const entry of entries) {
		if (!hasKnownReferences(entry, knownIds)) return false;
		knownIds.add(entry.id);
	}
	return true;
}

export function applyBtwEvent(state: BtwState, event: BtwStateEvent): void {
	if (event.kind === "thread_created") {
		state.threads.set(event.thread.id, {
			...structuredClone(event.thread),
			entries: [],
			turns: [],
			status: "idle",
		});
		return;
	}

	const thread = state.threads.get(event.threadId);
	if (!thread) return;

	switch (event.kind) {
		case "turn_queued": {
			const existing = thread.turns.find((turn) => turn.id === event.turn.id);
			if (existing) {
				existing.prompt = event.turn.prompt;
				existing.status = "queued";
				existing.updatedAt = event.at;
				existing.reason = undefined;
			} else {
				thread.turns.push({ ...structuredClone(event.turn), status: "queued" });
			}
			thread.updatedAt = event.at;
			thread.status = deriveThreadStatus(thread);
			return;
		}
		case "turn_started":
			updateTurn(thread, event.turnId, "running", event.at);
			return;
		case "turn_completed":
			updateTurn(thread, event.turnId, "completed", event.at);
			return;
		case "turn_paused":
			updateTurn(thread, event.turnId, "paused", event.at, event.reason);
			return;
		case "turn_interrupted":
			updateTurn(thread, event.turnId, "interrupted", event.at, event.reason);
			return;
		case "entry_appended": {
			const knownIds = new Set([...thread.seedEntries, ...thread.entries].map((entry) => entry.id));
			if (!hasKnownReferences(event.entry, knownIds)) return;
			thread.entries.push(structuredClone(event.entry));
			thread.updatedAt = event.at;
			return;
		}
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isSessionEntry(value: unknown): boolean {
	if (
		!isObject(value) ||
		typeof value.type !== "string" ||
		typeof value.id !== "string" ||
		(value.parentId !== null && typeof value.parentId !== "string") ||
		typeof value.timestamp !== "string"
	) {
		return false;
	}
	switch (value.type) {
		case "message":
			return isObject(value.message) && typeof value.message.role === "string";
		case "thinking_level_change":
			return typeof value.thinkingLevel === "string";
		case "model_change":
			return typeof value.provider === "string" && typeof value.modelId === "string";
		case "compaction":
			return (
				typeof value.summary === "string" &&
				typeof value.firstKeptEntryId === "string" &&
				typeof value.tokensBefore === "number"
			);
		case "branch_summary":
			return typeof value.fromId === "string" && typeof value.summary === "string";
		case "custom":
			return typeof value.customType === "string";
		case "custom_message":
			return (
				typeof value.customType === "string" &&
				(typeof value.content === "string" || Array.isArray(value.content)) &&
				typeof value.display === "boolean"
			);
		case "label":
			return (
				typeof value.targetId === "string" &&
				(value.label === undefined || typeof value.label === "string")
			);
		case "session_info":
			return value.name === undefined || typeof value.name === "string";
		default:
			return false;
	}
}

function isBtwStateEvent(value: unknown): value is BtwStateEvent {
	if (!isObject(value) || value.version !== BTW_STATE_VERSION || typeof value.kind !== "string" || typeof value.at !== "number") {
		return false;
	}
	if (value.kind === "thread_created") {
		if (!isObject(value.thread) || !isObject(value.thread.model)) return false;
		return (
			typeof value.thread.id === "string" &&
			typeof value.thread.title === "string" &&
			typeof value.thread.createdAt === "number" &&
			typeof value.thread.updatedAt === "number" &&
			typeof value.thread.model.provider === "string" &&
			typeof value.thread.model.id === "string" &&
			typeof value.thread.model.api === "string" &&
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.thread.thinkingLevel)) &&
			Array.isArray(value.thread.seedEntries) &&
			value.thread.seedEntries.every(isSessionEntry) &&
			entriesHaveValidReferences(value.thread.seedEntries as SessionEntry[])
		);
	}
	if (typeof value.threadId !== "string") return false;
	if (value.kind === "turn_queued") {
		return (
			isObject(value.turn) &&
			typeof value.turn.id === "string" &&
			typeof value.turn.prompt === "string" &&
			typeof value.turn.createdAt === "number" &&
			typeof value.turn.updatedAt === "number"
		);
	}
	if (["turn_started", "turn_completed", "turn_paused", "turn_interrupted"].includes(value.kind)) {
		return typeof value.turnId === "string" && (value.reason === undefined || typeof value.reason === "string");
	}
	if (value.kind === "entry_appended") {
		return isSessionEntry(value.entry);
	}
	return false;
}

export function reduceBtwState(entries: readonly SessionEntry[], normalizePending = true): BtwState {
	const state = createBtwState();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BTW_STATE_ENTRY_TYPE || !isBtwStateEvent(entry.data)) {
			continue;
		}
		applyBtwEvent(state, entry.data);
	}

	if (normalizePending) {
		for (const thread of state.threads.values()) {
			for (const turn of thread.turns) {
				if (turn.status === "running") {
					turn.status = "interrupted";
					turn.reason ??= "Pi stopped before this BTW turn finished.";
				} else if (turn.status === "queued") {
					turn.status = "paused";
					turn.reason ??= "Resume this queued BTW turn explicitly.";
				}
			}
			thread.status = deriveThreadStatus(thread);
		}
	}

	return state;
}

export function listBtwThreads(state: BtwState): BtwThread[] {
	return [...state.threads.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
				? [String(part.text)]
				: [],
		)
		.join("\n")
		.trim();
}
