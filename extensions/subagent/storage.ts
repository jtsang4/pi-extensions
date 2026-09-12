import { randomUUID } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { truncateHead, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Child, History } from "./runtime.ts";

export type ArchiveRef = { parentId: string; childId: string; runId: string };
export type StorageContext = { store: SubagentStorage; parentId: string; cwd: string; branchId: string | null };
export type ResultPage = { text: string; offset: number; nextOffset?: number; totalBytes: number };
type Meta = {
	format: "pi-subagent-run-v1";
	ref: ArchiveRef;
	pid: number;
	createdAt: number;
	completedAt?: number;
	cwd: string;
	branchId: string | null;
	task: string;
	child: Omit<Child, "history">;
};

function component(value: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("Invalid subagent archive ID.");
	return value;
}

function numberSetting(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
	if (env[key] === undefined) return fallback;
	const value = Number(env[key]);
	if (!Number.isFinite(value) || value < 0 || !env[key]!.trim()) throw new Error(`${key} must be a nonnegative number.`);
	return value;
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function validHistory(value: unknown): value is History {
	const blocks = (content: unknown): boolean => Array.isArray(content) && content.every((block) => {
		if (!block || typeof block !== "object") return false;
		switch (block.type) {
			case "text": return typeof block.text === "string";
			case "thinking": return typeof block.thinking === "string";
			case "image": return typeof block.data === "string" && typeof block.mimeType === "string";
			case "toolCall": return typeof block.id === "string" && typeof block.name === "string" && block.arguments !== null && typeof block.arguments === "object";
			default: return false;
		}
	});
	return Array.isArray(value) && value.every((message) => {
		if (!message || typeof message !== "object") return false;
		switch (message.role) {
			case "user": case "custom": return typeof message.content === "string" || blocks(message.content);
			case "assistant": return blocks(message.content) && ["stop", "toolUse", "length", "error", "aborted"].includes(message.stopReason);
			case "toolResult": return typeof message.toolName === "string" && typeof message.toolCallId === "string" && blocks(message.content);
			case "compactionSummary": case "branchSummary": return typeof message.summary === "string";
			case "bashExecution": return typeof message.command === "string" && typeof message.output === "string";
			default: return false;
		}
	});
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}

/** Global archives are independent of Pi's official agent directory. No I/O in the constructor. */
export class SubagentStorage {
	readonly root: string;
	readonly retentionDays: number;
	readonly maxBytes: number;
	private protectedParents = new Set<string>();
	private ownerId = randomUUID();
	constructor(options: { root?: string; retentionDays?: number; maxBytes?: number } = {}) {
		this.root = resolve(options.root ?? join(homedir(), ".pi", "subagents"));
		this.retentionDays = options.retentionDays ?? 30;
		this.maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
	}

	static fromEnvironment(env: NodeJS.ProcessEnv = process.env): SubagentStorage {
		const root = env.PI_SUBAGENT_STORAGE_DIR;
		return new SubagentStorage({
			root: root?.startsWith("~/") ? join(homedir(), root.slice(2)) : root || undefined,
			retentionDays: numberSetting(env, "PI_SUBAGENT_RETENTION_DAYS", 30),
			maxBytes: numberSetting(env, "PI_SUBAGENT_MAX_STORAGE_MB", 1024) * 1024 * 1024,
		});
	}

	path(ref: ArchiveRef): string {
		return join(this.root, component(ref.parentId), component(ref.childId), component(ref.runId));
	}

	private async checkDirectory(ref: ArchiveRef): Promise<string> {
		let path = this.root;
		for (const [index, id] of [ref.parentId, ref.childId, ref.runId].entries()) {
			path = join(path, component(id));
			if (index === 2) {
				try { await lstat(path); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.recover(ref); }
			}
			if (!(await lstat(path)).isDirectory()) throw new Error("Subagent archive directory is missing or is a symlink.");
			if (index === 0) await this.protect(ref.parentId);
		}
		return path;
	}

	private async recover(ref: ArchiveRef): Promise<void> {
		const path = this.path(ref);
		const quarantine = `${path}.pruning`;
		try { await lstat(path); return; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		try {
			if (!(await lstat(quarantine)).isDirectory() || !(await lstat(join(quarantine, "meta.json"))).isFile()) throw new Error("Invalid subagent cleanup quarantine.");
			const meta = JSON.parse(await readFile(join(quarantine, "meta.json"), "utf8")) as Meta;
			if (meta.format !== "pi-subagent-run-v1" || meta.ref?.parentId !== ref.parentId || meta.ref.childId !== ref.childId || meta.ref.runId !== ref.runId) throw new Error("Subagent cleanup quarantine identity is invalid.");
			await rename(quarantine, path);
		} catch (error) {
			if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}

	private async openArchiveFile(ref: ArchiveRef, name: "checkpoint.json" | "result.md") {
		const directory = await this.checkDirectory(ref);
		for (let attempt = 0; ; attempt++) {
			try {
				const path = join(directory, name);
				if (!(await lstat(path)).isFile()) throw new Error("Subagent archive content is not a regular file.");
				const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				try {
					if (!(await file.stat()).isFile()) throw new Error("Subagent archive content is not a regular file.");
					return file;
				} catch (error) { await file.close(); throw error; }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Subagent archive content is not a regular file.");
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 2) throw error;
				await this.recover(ref);
			}
		}
	}

	async protect(parentId: string): Promise<void> {
		// A resumed session may reference runs created by a process that has exited.
		// Each holder has its own lease, even when several sessions share a process.
		const path = join(this.root, component(parentId));
		if (this.protectedParents.has(parentId)) return;
		try {
			if (!(await lstat(path)).isDirectory()) throw new Error("Subagent archive parent is not a directory.");
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		await atomicJson(join(path, `.lease-${process.pid}-${this.ownerId}.json`), { format: "pi-subagent-lease-v1", pid: process.pid, ownerId: this.ownerId });
		this.protectedParents.add(parentId);
	}

	async release(): Promise<void> {
		for (const parentId of this.protectedParents) {
			await rm(join(this.root, parentId, `.lease-${process.pid}-${this.ownerId}.json`), { force: true });
			this.protectedParents.delete(parentId);
		}
	}

	private async hasActiveLease(parentId: string): Promise<boolean> {
		const path = join(this.root, parentId);
		let entries;
		try { entries = await readdir(path, { withFileTypes: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
		for (const entry of entries) {
			if (!entry.isFile() || !/^\.lease-\d+(?:-[a-f0-9-]{36})?\.json$/.test(entry.name)) continue;
			try {
				const lease = JSON.parse(await readFile(join(path, entry.name), "utf8"));
				const suffix = lease.ownerId === undefined ? "" : typeof lease.ownerId === "string" && /^[a-f0-9-]{36}$/.test(lease.ownerId) ? `-${lease.ownerId}` : null;
				if (lease.format !== "pi-subagent-lease-v1" || !Number.isInteger(lease.pid) || lease.pid <= 0 || suffix === null || entry.name !== `.lease-${lease.pid}${suffix}.json`) continue;
				if (processAlive(lease.pid)) return true;
				await rm(join(path, entry.name), { force: true });
			} catch { /* Ignore unrelated or concurrently removed lease files. */ }
		}
		return false;
	}

	async begin(ref: ArchiveRef, context: Omit<StorageContext, "store">, child: Child, task: string): Promise<RunArchive> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		let path = this.root;
		for (const id of [ref.parentId, ref.childId]) {
			path = join(path, component(id));
			await mkdir(path, { recursive: true, mode: 0o700 });
			if (!(await lstat(path)).isDirectory()) throw new Error("Subagent archive parent is not a directory.");
		}
		await this.protect(ref.parentId);
		path = this.path(ref);
		await mkdir(path, { mode: 0o700 }); // Unique run IDs; never reuse or overwrite a run.
		await mkdir(join(path, "artifacts"), { mode: 0o700 });
		const { history: _history, ...configuration } = child;
		const meta: Meta = { format: "pi-subagent-run-v1", ref, pid: process.pid, createdAt: Date.now(),
			cwd: context.cwd, branchId: context.branchId, task, child: configuration };
		await atomicJson(join(path, "meta.json"), meta);
		await writeFile(join(path, "events.jsonl"), JSON.stringify({ type: "run_start", time: meta.createdAt, task }) + "\n", { flag: "wx", mode: 0o600 });
		return new RunArchive(path, meta);
	}

	async checkHistory(ref: ArchiveRef): Promise<void> {
		const file = await this.openArchiveFile(ref, "checkpoint.json");
		await file.close();
	}

	async readHistory(ref: ArchiveRef): Promise<History> {
		const file = await this.openArchiveFile(ref, "checkpoint.json");
		try {
			const saved = JSON.parse(await file.readFile("utf8")) as { version?: number; ref?: ArchiveRef; history?: History };
			if (saved.version !== 1 || saved.ref?.parentId !== ref.parentId || saved.ref.childId !== ref.childId || saved.ref.runId !== ref.runId || !validHistory(saved.history)) {
				throw new Error("Subagent checkpoint identity or format is invalid.");
			}
			return saved.history;
		} finally { await file.close(); }
	}

	async readResult(ref: ArchiveRef, offset = 0): Promise<ResultPage> {
		if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Result offset must be a nonnegative byte offset from a previous page.");
		const file = await this.openArchiveFile(ref, "result.md");
		try {
			const { size } = await file.stat();
			if (offset > size) throw new Error("Result offset exceeds the archived report.");
			const buffer = Buffer.alloc(16_384 + 4);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
				if (!read.bytesRead) break;
				bytesRead += read.bytesRead;
			}
			if (bytesRead && (buffer[0]! & 0xc0) === 0x80) throw new Error("Result offset splits a UTF-8 character; use nextOffset from a previous page.");
			let end = Math.min(bytesRead, 16_384);
			if (end < bytesRead) while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
			const text = truncateHead(buffer.subarray(0, end).toString("utf8"), { maxBytes: 16_384, maxLines: 400 }).content;
			const next = offset + Buffer.byteLength(text);
			return { text, offset, nextOffset: next < size ? next : undefined, totalBytes: size };
		} finally { await file.close(); }
	}

	/** Remove only our expired/over-budget archives whose owning Pi process has exited. */
	async prune(now = Date.now(), protectedParents: ReadonlySet<string> = new Set()): Promise<void> {
		if (this.retentionDays === 0 && this.maxBytes === 0) return;
		const directories = async (path: string) => {
			try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		};
		const size = async (path: string): Promise<number> => {
			let bytes = 0;
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const file = join(path, entry.name);
				if (entry.isDirectory()) bytes += await size(file);
				else if (entry.isFile()) bytes += (await lstat(file)).size;
			}
			return bytes;
		};
		const candidates: { path: string; ref: ArchiveRef; quarantined: boolean; bytes: number; time: number; protected: boolean }[] = [];
		for (const parent of await directories(this.root)) {
			const protectedParent = protectedParents.has(parent.name) || await this.hasActiveLease(parent.name);
			for (const child of await directories(join(this.root, parent.name))) {
				for (const run of await directories(join(this.root, parent.name, child.name))) {
					const path = join(this.root, parent.name, child.name, run.name);
					const quarantined = run.name.endsWith(".pruning");
					const runId = quarantined ? run.name.slice(0, -".pruning".length) : run.name;
					try {
						const metaFile = join(path, "meta.json");
						if (!(await lstat(metaFile)).isFile()) continue;
						const meta = JSON.parse(await readFile(metaFile, "utf8")) as Meta;
						if (meta.format !== "pi-subagent-run-v1" || meta.ref?.parentId !== parent.name || meta.ref.childId !== child.name || meta.ref.runId !== runId || !Number.isFinite(meta.createdAt) || (meta.completedAt !== undefined && !Number.isFinite(meta.completedAt)) || !Number.isInteger(meta.pid) || meta.pid <= 0) continue;
						this.path(meta.ref); // Only canonical IDs participate in cleanup or recovery.
						candidates.push({ path, ref: meta.ref, quarantined, bytes: this.maxBytes > 0 ? await size(path) : 0, time: meta.completedAt ?? meta.createdAt, protected: (meta.completedAt === undefined && processAlive(meta.pid)) || protectedParent });
					} catch { /* Incomplete, foreign, or concurrently removed directories are left alone. */ }
				}
			}
		}
		let total = candidates.reduce((bytes, entry) => bytes + entry.bytes, 0);
		for (const entry of candidates.sort((a, b) => a.time - b.time)) {
			const expired = this.retentionDays > 0 && entry.time < now - this.retentionDays * 86_400_000;
			if (entry.protected || (!expired && !(this.maxBytes > 0 && total > this.maxBytes)) || await this.hasActiveLease(entry.ref.parentId)) {
				if (entry.quarantined) await this.recover(entry.ref);
				continue;
			}
			const quarantine = `${this.path(entry.ref)}.pruning`;
			if (!entry.quarantined) {
				try { await rename(entry.path, quarantine); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
			}
			// Moving the run makes expiry observable before deletion. A reader that
			// already acquired it wins this race; interrupted moves remain recoverable.
			if (await this.hasActiveLease(entry.ref.parentId)) { await this.recover(entry.ref); continue; }
			await rm(quarantine, { recursive: true, force: true });
			await rmdir(dirname(quarantine)).catch(() => {});
			await rmdir(dirname(dirname(quarantine))).catch(() => {});
			total -= entry.bytes;
		}
	}
}

/** Serial append queue: background write failures are observed during settlement. */
export class RunArchive {
	private pending: Promise<void> = Promise.resolve();
	private failure?: Error;
	private sequence = 0;
	readonly directory: string;
	private meta: Meta;
	constructor(directory: string, meta: Meta) { this.directory = directory; this.meta = meta; }

	record(event: AgentSessionEvent): void {
		if (event.type !== "message_end" && event.type !== "tool_execution_start" && event.type !== "compaction_end") return;
		const line = JSON.stringify({ sequence: ++this.sequence, time: Date.now(), event }) + "\n";
		const message = event.type === "message_end" ? event.message : undefined;
		const details = message?.role === "toolResult" && message.toolName === "bash" ? message.details as { fullOutputPath?: string } | undefined : undefined;
		const outputPath = details?.fullOutputPath;
		const artifactName = `bash-output-${this.sequence}.log`;
		this.pending = this.pending.then(async () => {
			if (this.failure) return;
			await appendFile(join(this.directory, "events.jsonl"), line);
			if (typeof outputPath === "string") {
				await copyFile(outputPath, join(this.directory, "artifacts", artifactName), constants.COPYFILE_EXCL);
				await appendFile(join(this.directory, "events.jsonl"), JSON.stringify({ type: "artifact", path: `artifacts/${artifactName}`, source: outputPath }) + "\n");
			}
		}).catch((error: Error) => { this.failure ??= error; });
	}

	async finish(child: Child, fullOutput: string, saveCheckpoint = true): Promise<void> {
		try { await this.save(child, fullOutput, saveCheckpoint); }
		catch (error) {
			const { history: _history, ...configuration } = child;
			await atomicJson(join(this.directory, "meta.json"), { ...this.meta, completedAt: Date.now(),
				child: { ...configuration, status: "failed", error: `Subagent archive failed: ${String(error)}` } }).catch(() => {});
			throw error;
		}
	}

	private async save(child: Child, fullOutput: string, saveCheckpoint: boolean): Promise<void> {
		await this.pending;
		if (this.failure) throw this.failure;
		await writeFile(join(this.directory, "result.md"), fullOutput, { flag: "wx", mode: 0o600 });
		if (saveCheckpoint) await writeFile(join(this.directory, "checkpoint.json"), JSON.stringify({ version: 1, ref: this.meta.ref, history: child.history }) + "\n", { flag: "wx", mode: 0o600 });
		const { history: _history, ...configuration } = child;
		this.meta = { ...this.meta, completedAt: Date.now(), child: { ...configuration, checkpoint: saveCheckpoint ? this.meta.ref : child.checkpoint } };
		await appendFile(join(this.directory, "events.jsonl"), JSON.stringify({ type: "run_end", time: this.meta.completedAt, status: child.status, error: child.error }) + "\n");
		await atomicJson(join(this.directory, "meta.json"), this.meta);
	}
}
