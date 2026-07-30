import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component, type Focusable, type OverlayHandle } from "@earendil-works/pi-tui";
import { BTW_HANDOFF_MESSAGE_TYPE } from "./state.ts";
import { BtwRuntime } from "./runtime.ts";
import { BtwConversationOverlay, createThreadPicker, type PickerAction } from "./ui.ts";

const STATUS_KEY = "jtsang4-btw";

type OverlayRuntime = {
	ctx: ExtensionCommandContext;
	threadId: string;
	handle?: OverlayHandle;
	component?: BtwConversationOverlay;
	done?: () => void;
	closed: boolean;
};

export default function btwExtension(pi: ExtensionAPI) {
	let currentContext: ExtensionContext | ExtensionCommandContext | undefined;
	let overlay: OverlayRuntime | undefined;

	const runtime = new BtwRuntime(pi, {
		onTurnFinished(thread, outcome) {
			const hidden = !overlay?.handle || overlay.handle.isHidden() || overlay.threadId !== thread.id;
			if (hidden && currentContext?.hasUI) {
				const reason = [...thread.turns].reverse().find((turn) => turn.status === "interrupted")?.reason;
				currentContext.ui.notify(
					outcome === "completed"
						? `BTW finished: ${thread.title}`
						: `BTW interrupted: ${thread.title}${reason ? ` · ${reason}` : ""}`,
					outcome === "completed" ? "info" : "warning",
				);
			}
		},
	});

	function updateUi(): void {
		const snapshot = runtime.getSnapshot();
		if (currentContext?.hasUI) {
			const running = snapshot.activeThreadId ? runtime.getThread(snapshot.activeThreadId) : undefined;
			const status = running
				? `BTW: ${running.title}${snapshot.queuedCount ? ` · ${snapshot.queuedCount} queued` : ""}`
				: snapshot.queuedCount
					? `BTW: ${snapshot.queuedCount} queued`
					: undefined;
			currentContext.ui.setStatus(STATUS_KEY, status);
		}
		overlay?.component?.refresh();
	}

	runtime.subscribe(updateUi);

	function closeOverlay(): void {
		if (!overlay || overlay.closed) return;
		overlay.closed = true;
		overlay.handle?.hide();
		overlay.done?.();
		overlay = undefined;
	}

	async function cancelActive(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (!(await runtime.cancelActive())) ctx.ui.notify("No BTW turn is running.", "info");
	}

	function showOverlay(ctx: ExtensionCommandContext, threadId: string): void {
		currentContext = ctx;
		const state: OverlayRuntime = { ctx, threadId, closed: false };
		overlay = state;
		// The command must return so Main can keep running; this controller retains input focus for the separate overlay.
		void ctx.ui
			.custom<void>((tui, theme, keybindings, done) => {
				state.done = done;
				const component = new BtwConversationOverlay(
					tui,
					theme,
					keybindings,
					threadId,
					(id) => runtime.getThread(id),
					() => runtime.getSnapshot().live,
					(id, prompt) => {
						try {
							runtime.enqueueFollowUp(id, prompt, ctx);
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
					},
					closeOverlay,
					() => void cancelActive(ctx),
					(id) => {
						const count = runtime.resumePaused(id, ctx);
						ctx.ui.notify(count ? `Resumed ${count} queued BTW turn${count === 1 ? "" : "s"}.` : "No paused BTW turns.", "info");
					},
				);
				state.component = component;
				state.handle = tui.showOverlay(component, {
					nonCapturing: true,
					width: "80%",
					minWidth: 72,
					maxHeight: "80%",
					anchor: "top-center",
					margin: { top: 1, left: 2, right: 2 },
				});
				const controller: Component & Focusable & { dispose(): void } = {
					get focused() {
						return component.focused;
					},
					set focused(value: boolean) {
						component.focused = value;
					},
					handleInput: (data) => component.handleInput(data),
					render: () => [theme.fg("dim", "BTW overlay active · Esc returns to the Main Session")],
					invalidate: () => component.invalidate(),
					dispose: () => {
						state.handle?.hide();
						if (overlay === state) overlay = undefined;
					},
				};
				return controller;
			})
			.catch((error) => {
				state.handle?.hide();
				if (overlay === state) overlay = undefined;
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			});
	}

	async function handlePickerAction(ctx: ExtensionCommandContext, action: PickerAction): Promise<void> {
		if (action.action === "resume") {
			const count = runtime.resumePaused(action.threadId, ctx);
			ctx.ui.notify(count ? `Resumed ${count} queued BTW turn${count === 1 ? "" : "s"}.` : "No paused BTW turns.", "info");
		} else if (action.action === "cancel") {
			const active = runtime.getSnapshot().activeThreadId;
			if (active !== action.threadId) ctx.ui.notify("The selected BTW Thread is not running.", "info");
			else await cancelActive(ctx);
		}
		showOverlay(ctx, action.threadId);
	}

	async function showPicker(ctx: ExtensionCommandContext): Promise<void> {
		const threads = runtime.getSnapshot().threads;
		if (threads.length === 0) {
			ctx.ui.notify("No BTW Threads yet. Use /btw <question> to create one.", "info");
			return;
		}
		const action = await ctx.ui.custom<PickerAction | undefined>(
			(tui, theme, keybindings, done) => createThreadPicker(tui, theme, keybindings, threads, done),
			{ overlay: true, overlayOptions: { width: "76%", maxHeight: "70%", anchor: "center", margin: 2 } },
		);
		if (action) await handlePickerAction(ctx, action);
	}

	pi.registerMessageRenderer(BTW_HANDOFF_MESSAGE_TYPE, (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("[BTW handoff]"))}\n${String(message.content)}`, 0, 0));
		return box;
	});

	pi.on("input", async (event) => {
		const target = overlay;
		if (event.source !== "interactive" || !target || target.closed) return { action: "continue" };
		const prompt = event.text.trim();
		if (prompt === "/cancel") await cancelActive(target.ctx);
		else if (prompt === "/resume") {
			const count = runtime.resumePaused(target.threadId, target.ctx);
			target.ctx.ui.notify(count ? `Resumed ${count} queued BTW turn${count === 1 ? "" : "s"}.` : "No paused BTW turns.", "info");
		} else if (prompt) {
			try {
				runtime.enqueueFollowUp(target.threadId, prompt, target.ctx);
			} catch (error) {
				target.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
		return { action: "handled" };
	});

	pi.registerCommand("btw", {
		description: "Create a persistent BTW side thread, or open the thread picker with no question.",
		handler: async (args, ctx) => {
			currentContext = ctx;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("BTW currently requires Pi TUI mode.", "error");
				return;
			}
			const question = args.trim();
			if (!question) {
				await showPicker(ctx);
				return;
			}
			try {
				const thread = runtime.createThread(question, ctx);
				showOverlay(ctx, thread.id);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("btw:cancel", {
		description: "Cancel the currently running BTW turn without clearing its thread.",
		handler: async (_args, ctx) => {
			currentContext = ctx;
			if (!(await runtime.cancelActive())) ctx.ui.notify("No BTW turn is running.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		runtime.restore(ctx.sessionManager.getBranch());
		updateUi();
	});

	pi.on("session_before_tree", async () => {
		await runtime.suspend("Main Session tree navigation interrupted this BTW turn.");
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentContext = ctx;
		closeOverlay();
		runtime.restore(ctx.sessionManager.getBranch());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await runtime.shutdown("Pi stopped before this BTW turn finished.");
		closeOverlay();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
