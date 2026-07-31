import { DynamicBorder, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	SelectList,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import { getTextContent, type BtwThread } from "./state.ts";
import type { BtwLiveTurn } from "./runtime.ts";

export type PickerAction = { action: "open" | "resume" | "cancel"; threadId: string };

function preview(value: unknown, maxLength = 100): string {
	if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
	try {
		const text = JSON.stringify(value);
		if (!text || text === "{}") return "";
		return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
	} catch {
		return "";
	}
}

function truncateToolDisplay(text: string): string {
	const maxLength = 4_000;
	return text.length > maxLength ? `${text.slice(0, maxLength)}\n[tool output truncated for display]` : text;
}

function toolResultText(value: unknown): string {
	if (value && typeof value === "object" && "content" in value) {
		const text = getTextContent((value as { content?: unknown }).content);
		if (text) return truncateToolDisplay(text);
	}
	return truncateToolDisplay(preview(value, 1_000) || "(no output)");
}

function wrapLines(lines: string[], width: number): string[] {
	return lines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}

function appendMessageLines(
	lines: string[],
	message: unknown,
	expandedTools: boolean,
	theme: Theme,
	includeToolCalls = true,
): void {
	if (!message || typeof message !== "object" || !("role" in message)) return;
	const typed = message as {
		role: string;
		content?: unknown;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
	};
	if (typed.role === "user") {
		const text = getTextContent(typed.content);
		if (text) lines.push(theme.fg("accent", theme.bold("You")), ...text.split("\n").map((line) => `  ${line}`), "");
		return;
	}
	if (typed.role === "assistant" && Array.isArray(typed.content)) {
		for (const part of typed.content) {
			if (!part || typeof part !== "object" || !("type" in part)) continue;
			if (part.type === "thinking" && "thinking" in part && part.thinking) {
				lines.push(theme.fg("warning", "Thinking"), ...String(part.thinking).split("\n").map((line) => `  ${line}`), "");
			} else if (part.type === "text" && "text" in part && part.text) {
				lines.push(theme.fg("success", theme.bold("Assistant")), ...String(part.text).split("\n").map((line) => `  ${line}`), "");
			} else if (includeToolCalls && part.type === "toolCall" && "name" in part) {
				const args = "arguments" in part ? preview(part.arguments) : "";
				lines.push(`${theme.fg("warning", "Tool")} ${theme.bold(String(part.name))}${args ? ` · ${theme.fg("dim", args)}` : ""}`);
			}
		}
		return;
	}
	if (typed.role === "toolResult") {
		const state = typed.isError ? theme.fg("error", "error") : theme.fg("success", "completed");
		lines.push(`  ↳ ${state}`);
		if (expandedTools) {
			const text = truncateToolDisplay(getTextContent(typed.content) || "(no output)");
			lines.push(...text.split("\n").map((line) => theme.fg("dim", `    ${line}`)), "");
		}
	}
}

function hasPersistedMessage(thread: BtwThread, message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message) || !("timestamp" in message)) return false;
	return thread.entries.some(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === message.role &&
			entry.message.timestamp === message.timestamp,
	);
}

export function buildThreadTranscript(
	thread: BtwThread,
	live: BtwLiveTurn | undefined,
	expandedTools: boolean,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	const activeLive = live?.threadId === thread.id ? live : undefined;
	const liveToolIds = new Set(activeLive?.tools.map((tool) => tool.id));
	for (const entry of thread.entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult" && liveToolIds.has(entry.message.toolCallId)) continue;
		const includeToolCalls = !activeLive?.assistant || entry.message.timestamp !== activeLive.assistant.timestamp;
		appendMessageLines(lines, entry.message, expandedTools, theme, includeToolCalls);
	}
	if (activeLive) {
		if (!activeLive.user || !hasPersistedMessage(thread, activeLive.user)) {
			lines.push(theme.fg("accent", theme.bold("You")), `  ${activeLive.prompt}`, "");
		}
		if (activeLive.assistant && !hasPersistedMessage(thread, activeLive.assistant)) {
			appendMessageLines(lines, activeLive.assistant, expandedTools, theme, false);
		}
		for (const tool of activeLive.tools) {
			const args = preview(tool.args);
			lines.push(`${theme.fg("warning", "Tool")} ${theme.bold(tool.name)}${args ? ` · ${theme.fg("dim", args)}` : ""}`);
			const state = tool.running
				? theme.fg("warning", "running")
				: tool.isError
					? theme.fg("error", "error")
					: theme.fg("success", "completed");
			lines.push(`  ↳ ${state}`);
			if (expandedTools && tool.result !== undefined) {
				lines.push(...toolResultText(tool.result).split("\n").map((line) => theme.fg("dim", `    ${line}`)), "");
			}
		}
	}
	const interruption = [...thread.turns].reverse().find((turn) => turn.status === "interrupted");
	if (thread.status === "interrupted" && interruption?.reason) {
		lines.push(theme.fg("error", "Interrupted"), ...interruption.reason.split("\n").map((line) => `  ${line}`), "");
	}
	if (lines.length === 0) lines.push(theme.fg("dim", "No BTW messages yet."));
	return wrapLines(lines, Math.max(1, width));
}

export function createThreadPicker(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	threads: BtwThread[],
	done: (result: PickerAction | undefined) => void,
): Component {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold("BTW Threads")), 1, 0));
	const items: SelectItem[] = threads.map((thread) => ({
		value: thread.id,
		label: `[${thread.status}] ${thread.title}`,
		description: `${thread.model.provider}/${thread.model.id} · ${new Date(thread.updatedAt).toLocaleString()}`,
	}));
	const maxRows = Math.max(1, (process.stdout.rows ?? 24) - 10);
	const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12, maxRows), {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	});
	list.onSelect = (item) => done({ action: "open", threadId: item.value });
	list.onCancel = () => done(undefined);
	container.addChild(list);
	container.addChild(new Text(theme.fg("dim", "Enter open · r resume paused · c cancel running · Esc close"), 1, 0));
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return {
		render: (width) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput(data) {
			const selected = list.getSelectedItem();
			if (selected && matchesKey(data, "r")) done({ action: "resume", threadId: selected.value });
			else if (selected && matchesKey(data, "c")) done({ action: "cancel", threadId: selected.value });
			else list.handleInput(data);
			tui.requestRender();
		},
	};
}

export class BtwConversationOverlay implements Component, Focusable {
	private readonly input = new Input();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly getThread: (threadId: string) => BtwThread | undefined;
	private readonly getLive: () => BtwLiveTurn | undefined;
	private readonly onSubmit: (threadId: string, prompt: string) => void;
	private readonly onHide: () => void;
	private readonly onCancel: () => void;
	private readonly onResume: (threadId: string) => void;
	private _focused = false;
	private threadId: string;
	private expandedTools = false;
	private scrollOffset = 0;
	private follow = true;
	private pasteBuffer = "";
	private pasting = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		threadId: string,
		getThread: (threadId: string) => BtwThread | undefined,
		getLive: () => BtwLiveTurn | undefined,
		onSubmit: (threadId: string, prompt: string) => void,
		onHide: () => void,
		onCancel: () => void,
		onResume: (threadId: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.threadId = threadId;
		this.getThread = getThread;
		this.getLive = getLive;
		this.onSubmit = onSubmit;
		this.onHide = onHide;
		this.onCancel = onCancel;
		this.onResume = onResume;
		this.input.onSubmit = (value) => {
			const prompt = value.trim();
			if (!prompt) return;
			this.input.setValue("");
			if (prompt === "/cancel") {
				this.onCancel();
				return;
			}
			if (prompt === "/resume") {
				this.onResume(this.threadId);
				return;
			}
			this.follow = true;
			this.onSubmit(this.threadId, prompt);
		};
		this.input.onEscape = this.onHide;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	refresh(): void {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.handlePaste(data)) return;
		const thread = this.getThread(this.threadId);
		if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
			this.onHide();
			return;
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.expandedTools = !this.expandedTools;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("r")) && thread?.status === "paused") {
			this.onResume(thread.id);
			return;
		}
		if ((matchesKey(data, Key.ctrl("k")) || this.keybindings.matches(data, "app.clear")) && thread?.status === "running") {
			this.onCancel();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
			this.follow = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - (matchesKey(data, Key.up) ? 1 : 8));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
			this.scrollOffset += matchesKey(data, Key.down) ? 1 : 8;
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private handlePaste(data: string): boolean {
		const start = "\x1b[200~";
		const end = "\x1b[201~";
		if (!this.pasting) {
			const startIndex = data.indexOf(start);
			if (startIndex === -1) return false;
			this.input.handleInput(data.slice(0, startIndex));
			this.pasteBuffer = data.slice(startIndex + start.length);
			this.pasting = true;
		} else {
			this.pasteBuffer += data;
		}
		const endIndex = this.pasteBuffer.indexOf(end);
		if (endIndex === -1) return true;
		const pasted = this.pasteBuffer.slice(0, endIndex).replace(/\r\n|\r|\n/g, " ");
		const remaining = this.pasteBuffer.slice(endIndex + end.length);
		this.pasteBuffer = "";
		this.pasting = false;
		this.input.handleInput(`${start}${pasted}${end}`);
		if (remaining) this.handleInput(remaining);
		this.tui.requestRender();
		return true;
	}

	private frame(content: string, innerWidth: number): string {
		const fitted = truncateToWidth(content, innerWidth, "");
		return `${this.theme.fg("border", "│")}${fitted}${" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))}${this.theme.fg("border", "│")}`;
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(1, width);
		const innerWidth = Math.max(1, dialogWidth - 2);
		const thread = this.getThread(this.threadId);
		if (!thread) return [this.frame(this.theme.fg("error", "BTW Thread unavailable"), innerWidth)];

		const terminalRows = process.stdout.rows ?? 32;
		const transcriptHeight = Math.max(1, Math.min(24, Math.floor(terminalRows * 0.8) - 8));
		const transcript = buildThreadTranscript(thread, this.getLive(), this.expandedTools, this.theme, innerWidth);
		const maxScroll = Math.max(0, transcript.length - transcriptHeight);
		if (this.follow) this.scrollOffset = maxScroll;
		else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visible = transcript.slice(this.scrollOffset, this.scrollOffset + transcriptHeight);
		while (visible.length < transcriptHeight) visible.push("");

		const top = this.theme.fg("border", `┌${"─".repeat(innerWidth)}┐`);
		const rule = this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
		const bottom = this.theme.fg("border", `└${"─".repeat(innerWidth)}┘`);
		const interruption = [...thread.turns].reverse().find((turn) => turn.status === "interrupted");
		const status = `${thread.status} · ${thread.model.provider}/${thread.model.id} · thinking ${thread.thinkingLevel}${
			thread.status === "interrupted" && interruption?.reason ? ` · ${interruption.reason}` : ""
		}`;
		const inputLine = truncateToWidth(this.input.render(innerWidth)[0] ?? "", innerWidth, "");
		return [
			top,
			this.frame(this.theme.fg("accent", this.theme.bold(`BTW · ${thread.title}`)), innerWidth),
			this.frame(this.theme.fg("dim", status), innerWidth),
			rule,
			...visible.map((line) => this.frame(line, innerWidth)),
			rule,
			this.frame(inputLine, innerWidth),
			this.frame(this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · Enter send · Esc hide · Ctrl+O tools"), innerWidth),
			bottom,
		].map((line) => truncateToWidth(line, dialogWidth, ""));
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
