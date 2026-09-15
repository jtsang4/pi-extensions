/**
 * Pure pipeline logic for better-compaction.
 *
 * Combines pi's compaction model (CompactionResult contract, cumulative file
 * tracking) with deepseek-harness compaction techniques (tool-result pruning
 * before summarization, verbatim message replay for prompt-cache reuse,
 * structured checkpoint instruction, summary shrink validation).
 *
 * All functions are pure so they can be unit-tested without pi or an LLM.
 */

import type { FileOperations } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Model, TextContent } from "@earendil-works/pi-ai";

/** Marks compaction entries produced by this extension (tests and audits grep for this). */
export const ENGINE_ID = "jtsang4-better-compaction";

export interface CompactionDetailsV1 {
	engine: typeof ENGINE_ID;
	version: 1;
	readFiles: string[];
	modifiedFiles: string[];
	prunedToolResults: number;
	summarizer: { provider: string; model: string };
	attempts: number;
}

// --- Tool-result pruning (model-free, before summarization) ---
// Mirrors dsh-compaction-tool-result-pruner: rewrite oversized tool results to
// a bounded head + marker + bounded tail. Idempotent by construction: the
// rewritten content is strictly smaller than the threshold.

export const PRUNE_THRESHOLD_CHARS = 8192;
export const PRUNE_HEAD_CHARS = 4096;
export const PRUNE_TAIL_CHARS = 1024;
export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

export interface PruneResult {
	messages: Message[];
	prunedCount: number;
}

/** Count UTF-16 code units of text content blocks. */
function textLength(content: Message["content"]): number {
	if (typeof content === "string") return content.length;
	return content.reduce((n, block) => (block.type === "text" ? n + block.text.length : n), 0);
}

/** Slice without splitting a UTF-16 surrogate pair at either boundary. */
function safeSlice(text: string, start: number, end: number): string {
	const len = text.length;
	let s = Math.max(0, Math.min(start, len));
	let e = Math.max(s, Math.min(end, len));
	// A low surrogate at the slice start is orphaned (its high half sits at s-1,
	// outside the slice): pull the high half in so the pair stays complete.
	if (s > 0 && s < len) {
		const prev = text.charCodeAt(s - 1);
		const at = text.charCodeAt(s);
		if (prev >= 0xd800 && prev <= 0xdbff && at >= 0xdc00 && at <= 0xdfff) s--;
	}
	// A low surrogate at the slice end means its high half (at e-1, inside the
	// slice) would be orphaned: back up so both halves stay out.
	if (e > s && e < len) {
		const at = text.charCodeAt(e);
		const before = text.charCodeAt(e - 1);
		if (at >= 0xdc00 && at <= 0xdfff && before >= 0xd800 && before <= 0xdbff) e--;
	}
	return text.slice(s, e);
}

/**
 * Prune oversized tool-result messages to head + marker + tail.
 * Non-text blocks (images) keep their relative positions; text is reassembled
 * from head/marker/tail in place of the original text blocks.
 */
export function pruneToolResults(
	messages: Message[],
	thresholdChars: number = PRUNE_THRESHOLD_CHARS,
	headChars: number = PRUNE_HEAD_CHARS,
	tailChars: number = PRUNE_TAIL_CHARS,
): PruneResult {
	if (headChars + tailChars + PRUNE_MARKER.length >= thresholdChars) {
		throw new Error("prune budgets must leave room below thresholdChars");
	}
	let prunedCount = 0;
	const out = messages.map((message): Message => {
		if (message.role !== "toolResult" || typeof message.content === "string") return message;
		const total = textLength(message.content);
		if (total <= thresholdChars) return message;
		prunedCount++;
		const blocks = [...message.content];
		// Splice all text blocks into one head/marker/tail replacement at the first
		// text block's position; keep non-text blocks where they were.
		const merged: string[] = [];
		let firstTextIndex = -1;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			if (block.type !== "text") continue;
			merged.push(block.text);
			if (firstTextIndex === -1) firstTextIndex = i;
			blocks[i] = { type: "text", text: "" }; // placeholder, filled below
		}
		if (firstTextIndex === -1) return message; // no text blocks: leave untouched
		const text = merged.join("\n");
		(blocks[firstTextIndex] as TextContent).text =
			safeSlice(text, 0, headChars) + PRUNE_MARKER + safeSlice(text, text.length - tailChars, text.length);
		// Drop empty placeholders that pruning made redundant.
		const content = blocks.filter((b) => b.type !== "text" || b.text !== "");
		return { ...message, content };
	});
	return { messages: out, prunedCount };
}

/**
 * Drop tool-result messages whose tool call is not part of the replayed span
 * (e.g. a cut boundary or custom message left an orphan). Providers like
 * OpenAI/DeepSeek reject role 'tool' messages without a preceding 'tool_calls'.
 */
export function dropOrphanToolResults(messages: Message[]): Message[] {
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall") callIds.add(block.id);
			}
		}
	}
	return messages.filter((m) => m.role !== "toolResult" || callIds.has(m.toolCallId));
}

// --- Model-family guard ---
// Yield to pi-openai-server-compaction (server-side Responses compaction) for
// OpenAI Responses-family models. It abstains otherwise; this extension
// abstains here, so exactly one custom compactor handles any model.

const REMOTE_COMPACTION_PROVIDERS = new Set(["openai", "openai-codex"]);
const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

export function shouldYieldToRemoteCompaction(model: Model<any> | undefined): boolean {
	if (!model) return false;
	return REMOTE_COMPACTION_PROVIDERS.has(model.provider) && RESPONSES_APIS.has(model.api);
}

// --- Checkpoint instruction (dsh 8-section template + pi file-ops tags) ---

export interface InstructionOptions {
	previousSummary?: string;
	customInstructions?: string;
	/** "overflow" compactions may sacrifice detail to guarantee shrinkage. */
	reason: "manual" | "threshold" | "overflow";
	/** Extra tightening applied on shrink-validation retry. */
	retry?: number;
}

export const CHECKPOINT_SECTIONS = [
	"## Primary Request and Intent",
	"## Key Technical Concepts",
	"## Files and Code",
	"## Errors and Fixes",
	"## Pending Jobs",
	"## Current Work",
	"## Next Step",
	"## Critical Context",
] as const;

export function buildCheckpointInstruction(options: InstructionOptions): string {
	const lines: string[] = [
		"You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
		"",
		"Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
		"",
		"## Primary Request and Intent",
		"- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
		"",
		"## Key Technical Concepts",
		"- [technologies, frameworks, patterns, and conventions in play]",
		"",
		"## Files and Code",
		"- [exact path: why it matters, key changes or snippets]",
		"",
		"## Errors and Fixes",
		"- [error: how it was resolved, plus any related user feedback]",
		"",
		"## Pending Jobs",
		"- [explicitly requested work not yet completed]",
		"",
		"## Current Work",
		"- [precisely what was in progress at this checkpoint]",
		"",
		"## Next Step",
		"- [the single next action, directly in line with the most recent request, or \"(none)\"]",
		"",
		"## Critical Context",
		"- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
		"",
		"After the sections, list files touched by the conversation in these exact XML tags:",
		"<read-files>",
		"path/to/file1",
		"</read-files>",
		"<modified-files>",
		"path/to/changed1",
		"</modified-files>",
		"Use an empty tag body when there are none.",
		"",
		"Rules:",
		"- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
		"- Capture user feedback and explicit instructions faithfully, especially corrections.",
		"- Do NOT mention this summarization request or that the context was compacted.",
		"- Output only the checkpoint text: do not call any tool or take any other action.",
	];
	if (options.previousSummary) {
		lines.push(
			`- The conversation already contains a <summary> block from a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
		);
	}
	if (options.reason === "overflow") {
		lines.push(
			"- Context overflowed the model window: compress aggressively. Drop verbose evidence, keep identifiers, decisions, and next steps.",
		);
	}
	if (options.customInstructions) {
		lines.push(`- Additional focus from the user: ${options.customInstructions}`);
	}
	if (options.retry && options.retry > 0) {
		lines.push(
			`- Your previous checkpoint (attempt ${options.retry}) was too large. This time produce a materially shorter checkpoint: at most half its length, keeping only essential facts.`,
		);
	}
	return lines.join("\n");
}

// --- Summarization request assembly (verbatim replay, cache-friendly) ---

/**
 * Build the summarization messages: replay the (pruned) conversation verbatim,
 * then append the checkpoint instruction as the final user message. Replaying
 * real messages keeps the request a near-prefix of the main conversation
 * request, so provider prompt caches stay warm instead of being invalidated.
 */
export function buildSummaryMessages(llmMessages: Message[], instruction: string): Message[] {
	const instructionMessage: Message = {
		role: "user",
		content: [{ type: "text", text: instruction }],
		timestamp: Date.now(),
	};
	return [...llmMessages, instructionMessage];
}

// --- Summary validation ---

export function extractSummaryText(assistant: AssistantMessage): string {
	return assistant.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text.trim())
		.join("\n")
		.trim();
}

/** Conservative chars/4 estimate, matching pi's estimateTokens heuristic. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Structured checkpoints cost this many tokens before any content; below this
 * span size, strict shrinkage is unachievable and pointless. */
export const SHRINK_VALIDATION_FLOOR_TOKENS = 2048;

/**
 * The summary must be non-empty, and strictly smaller than the span it
 * replaces — except for spans below SHRINK_VALIDATION_FLOOR_TOKENS, where the
 * template scaffold alone rivals the source and compaction frees nothing
 * either way (mirrors pi's default: no validation).
 */
export function summaryPassesShrink(summary: string, sourceTokens: number): boolean {
	const tokens = estimateTextTokens(summary.trim());
	const target = Math.max(sourceTokens, SHRINK_VALIDATION_FLOOR_TOKENS);
	return tokens > 0 && tokens < target;
}

// --- Compaction details (pi-compatible cumulative file tracking) ---

interface PriorDetails {
	readFiles?: string[];
	modifiedFiles?: string[];
}

/** Extract the last compaction entry's file lists from branch entries. */
export function mergeFileLists(fileOps: FileOperations, priorDetails: unknown): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const current = { read: fileOps.read, written: fileOps.written, edited: fileOps.edited };
	const { readFiles, modifiedFiles } = computeFileLists(current);
	const prior = (priorDetails ?? {}) as PriorDetails;
	const mergedRead = [...new Set([...(prior.readFiles ?? []), ...readFiles])].sort();
	const mergedModified = [...new Set([...(prior.modifiedFiles ?? []), ...modifiedFiles])].sort();
	// A file modified later is no longer read-only.
	return {
		readFiles: mergedRead.filter((f) => !mergedModified.includes(f)),
		modifiedFiles: mergedModified,
	};
}

// computeFileLists re-implemented locally: not guaranteed on the package's
// public export surface across versions, and it is three lines.
function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

export function buildCompactionDetails(params: {
	fileOps: FileOperations;
	priorDetails: unknown;
	prunedToolResults: number;
	provider: string;
	model: string;
	attempts: number;
}): CompactionDetailsV1 {
	const { readFiles, modifiedFiles } = mergeFileLists(params.fileOps, params.priorDetails);
	return {
		engine: ENGINE_ID,
		version: 1,
		readFiles,
		modifiedFiles,
		prunedToolResults: params.prunedToolResults,
		summarizer: { provider: params.provider, model: params.model },
		attempts: params.attempts,
	};
}
