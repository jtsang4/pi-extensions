import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";

const optional = <T extends TSchema>(schema: T, description: string) =>
	Type.Optional(Type.Union([Type.Unsafe<null>({ enum: [null] }), schema], {
		description: `${description} Omit or use null when unused.`,
	}));

// Keep one object schema for providers that do not support top-level unions.
// Nullable options also let providers require every property without inventing values.
// Match literal null first without type coercion: Pi otherwise converts 0 to
// null or null to 0/"" before execute, changing budgets and defaults. An anyOf
// also avoids older Pi TypeBox compilers dereferencing nullable-array items.
export const parameters = Type.Object({
	action: StringEnum(["spawn", "list", "wait", "send", "stop", "forget", "result"]),
	task: optional(Type.String({ maxLength: 32_000 }), "spawn/send: required nonempty complete task."),
	id: optional(Type.String(), "send/stop/forget/result: an existing child ID; wait: one child ID instead of ids. Never invent an ID."),
	ids: optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 }), "wait only: existing child IDs instead of id. Null or an empty array selects all children when id is absent."),
	role: optional(StringEnum(["scout", "worker"]), "spawn only: defaults to scout."),
	model: optional(Type.String(), "spawn only: exact provider/model-id; null or an empty string uses the parent's model. send keeps the original model."),
	timeoutMs: optional(Type.Integer({ minimum: 1000, maximum: 600_000 }), "spawn only: deadline per child turn, default 300000."),
	maxTurns: optional(Type.Integer({ minimum: 1, maximum: 100 }), "spawn only: model-turn budget per task, default 32."),
	waitMs: optional(Type.Integer({ minimum: 1, maximum: 60_000 }), "wait only: wait at most this long, default 10000."),
	waitFor: optional(StringEnum(["all", "any"]), "wait only: default all; any returns when one selected child is terminal."),
	offset: optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), "result only: byte offset, default 0; continue with the returned nextOffset."),
}, { additionalProperties: false });

type Input = Static<typeof parameters>;
type Arguments = { [K in keyof Input]: Exclude<Input[K], null> };
const ACTION_FIELDS: Record<Input["action"], readonly string[]> = {
	spawn: ["task", "role", "model", "timeoutMs", "maxTurns"], send: ["id", "task"],
	wait: ["id", "ids", "waitMs", "waitFor"], stop: ["id"], forget: ["id"], result: ["id", "offset"], list: [],
};

/** Project a validated call onto the selected action before interpreting IDs or defaults. */
export function normalizeArguments(input: Input): { args: Arguments; ignoredParameters: string[] } {
	if (!Object.hasOwn(ACTION_FIELDS, input.action)) throw new Error(`Unknown subagent action: ${input.action}`);
	const ignoredParameters: string[] = [];
	const args = Object.fromEntries(Object.entries(input).filter(([key, value]) => {
		if (!Object.hasOwn(parameters.properties, key)) throw new Error(`Unknown subagent parameter: ${key}`);
		if (value === null || value === undefined) return false;
		if (key === "action" || ACTION_FIELDS[input.action].includes(key)) return true;
		ignoredParameters.push(key);
		return false;
	})) as Arguments;
	if (args.id !== undefined) args.id = args.id.trim() || undefined;
	if (args.model !== undefined) args.model = args.model.trim() || undefined;
	if (args.ids?.length === 0) delete args.ids;
	if (args.id && args.ids) throw new Error("Choose id or ids, not both.");
	return { args, ignoredParameters };
}
