/**
 * better-compaction: hybrid compaction for pi.
 *
 * Keeps pi's compaction contract (CompactionResult, cumulative file tracking,
 * firstKeptEntryId) but upgrades the pipeline with deepseek-harness
 * techniques:
 *
 * 1. Model-free tool-result pruning before summarization (head + marker + tail)
 * 2. Verbatim message replay for the summarization call (prompt-cache friendly)
 * 3. Structured 8-section checkpoint instruction with prior-checkpoint merging
 * 4. Summary shrink validation with one tightened retry, then fall back to
 *    pi's default compaction
 *
 * Coexistence: for OpenAI Responses-family models this extension abstains
 * (returns undefined) so pi-openai-server-compaction's remote compaction
 * handles those. This extension never re-implements remote compaction.
 */

import { convertToLlm, estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	buildCheckpointInstruction,
	buildCompactionDetails,
	buildSummaryMessages,
	dropOrphanToolResults,
	estimateTextTokens,
	extractSummaryText,
	pruneToolResults,
	shouldYieldToRemoteCompaction,
	summaryPassesShrink,
	type CompactionDetailsV1,
} from "./pipeline.ts";

const MAX_SUMMARY_TOKENS = 8192;
const MAX_ATTEMPTS = 2;

/** LLM call seam: type of pi-ai/compat complete(). */
export type CompleteFn = (model: Model<any>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage>;

/** Find file lists recorded by the previous compaction entry, for cumulative tracking. */
function findPriorCompactionDetails(branchEntries: SessionEntry[]): unknown {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type === "compaction") return entry.details;
	}
	return undefined;
}

export interface SessionBeforeCompactEventLike {
	preparation: {
		firstKeptEntryId: string;
		messagesToSummarize: Parameters<typeof convertToLlm>[0][number][];
		turnPrefixMessages: Parameters<typeof convertToLlm>[0][number][];
		tokensBefore: number;
		previousSummary?: string;
		fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
	};
	branchEntries: SessionEntry[];
	customInstructions?: string;
	reason: "manual" | "threshold" | "overflow";
	signal: AbortSignal;
}

export interface ExtensionContextLike {
	model: Model<any> | undefined;
	hasUI: boolean;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	modelRegistry: { getApiKeyAndHeaders: (model: Model<any>) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }> };
	getSystemPrompt: () => string;
}

/**
 * The session_before_compact handler with an injectable LLM call seam so tests
 * exercise the full pipeline (prune → replay → validate → retry → details)
 * without network access.
 */
export function createSessionBeforeCompactHandler(completeFn: CompleteFn) {
	return async function sessionBeforeCompact(
		event: SessionBeforeCompactEventLike,
		ctx: ExtensionContextLike,
	): Promise<{ cancel?: boolean; compaction?: CompactionResult<CompactionDetailsV1> } | undefined> {
		const { preparation, branchEntries, customInstructions, reason, signal } = event;
		const model = ctx.model;

		// Yield to pi-openai-server-compaction for OpenAI Responses-family models.
		if (shouldYieldToRemoteCompaction(model)) return undefined;
		if (!model) return undefined;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined; // no credentials: let default compaction surface the error its way

		const source = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		// The span being replaced: the summarized messages plus the prior summary
		// that gets merged into the new one. pi's per-message estimate matches the
		// heuristic the default compactor itself uses.
		const sourceTokens = Math.max(
			1,
			source.reduce((n, m) => n + estimateTokens(m as never), 0) + estimateTextTokens(preparation.previousSummary ?? ""),
		);
		const pruned = pruneToolResults(convertToLlm(source));
		const replayMessages = dropOrphanToolResults(pruned.messages);

		let maxTokens = MAX_SUMMARY_TOKENS;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (signal.aborted) return undefined;
			const instruction = buildCheckpointInstruction({
				previousSummary: preparation.previousSummary,
				customInstructions,
				reason,
				retry: attempt - 1,
			});
			const messages = buildSummaryMessages(replayMessages, instruction);

			let response: AssistantMessage;
			try {
				const options: Record<string, unknown> = {
					maxTokens,
					signal,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					// Unlike pi's default compaction (cacheRetention "none" + fresh
					// session), replaying real messages as a near-prefix keeps provider
					// prompt caches reusable; only the tail instruction is novel.
					cacheRetention: "short",
				};
				if (model.reasoning) options.reasoning = "low";
				response = await completeFn(model, { systemPrompt: ctx.getSystemPrompt(), messages }, options);
			} catch (error) {
				if (signal.aborted) return undefined;
				if (attempt < MAX_ATTEMPTS) continue; // transient error: retry once
				notifyFallback(ctx, signal, error);
				return undefined;
			}
			if (response.stopReason === "aborted" || signal.aborted) return undefined;
			if (response.stopReason === "error") {
				if (attempt < MAX_ATTEMPTS) continue;
				notifyFallback(ctx, signal, new Error(response.errorMessage || "summarization stream error"));
				return undefined;
			}

			const summary = extractSummaryText(response);
			if (summaryPassesShrink(summary, sourceTokens)) {
				const details: CompactionDetailsV1 = buildCompactionDetails({
					fileOps: preparation.fileOps,
					priorDetails: findPriorCompactionDetails(branchEntries),
					prunedToolResults: pruned.prunedCount,
					provider: model.provider,
					model: model.id,
					attempts: attempt,
				});
				return {
					compaction: {
						summary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details,
					},
				};
			}
			// Summary failed shrink validation: retry with a tighter cap, or fall
			// back to pi's default compaction after the final attempt.
			maxTokens = Math.max(1024, Math.floor(maxTokens / 2));
		}
		if (!signal.aborted && ctx.hasUI) {
			ctx.ui.notify("better-compaction: summary failed shrink validation; using default compaction", "warning");
		}
		return undefined;
	};
}

function notifyFallback(ctx: ExtensionContextLike, signal: AbortSignal, error: unknown): void {
	if (signal.aborted || !ctx.hasUI) return;
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(`better-compaction failed (${message}); using default compaction`, "warning");
}

export default function betterCompactionExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", createSessionBeforeCompactHandler(complete));
}
