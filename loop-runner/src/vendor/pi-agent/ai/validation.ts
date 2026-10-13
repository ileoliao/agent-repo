/**
 * Argument checking for tool calls, replacing pi's TypeBox-based validateToolArguments.
 *
 * Same contract as pi's: arguments the model sent are checked against the tool's JSON Schema, sensible string values
 * are converted ("5" to 5, "true" to true), and a mismatch throws an Error whose message the model reads as the tool's result.
 * Only the parts of JSON Schema that Harbor Mate's tools use are supported: object, array, string, number, integer,
 * boolean, enum, required, nested properties and items. Unknown properties are allowed.
 */
import type { Tool, ToolCall } from "./types";

type Schema = Record<string, any>;

function coerce(value: unknown, schema: Schema | undefined): unknown {
	if (!schema || typeof schema !== "object") return value;
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
		return Number(value);
	}
	if (type === "boolean" && typeof value === "string") {
		if (value === "true") return true;
		if (value === "false") return false;
	}
	if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
	if (type === "array" && Array.isArray(value)) return value.map(v => coerce(v, schema.items));
	if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
		const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
		for (const [k, sub] of Object.entries<Schema>(schema.properties ?? {})) {
			if (k in out) out[k] = coerce(out[k], sub);
		}
		return out;
	}
	return value;
}

function check(value: unknown, schema: Schema | undefined, path: string, errors: string[]): void {
	if (!schema || typeof schema !== "object") return;
	const types: string[] = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.length) {
		const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		const okType = types.some(t => t === actual || (t === "integer" && actual === "number" && Number.isInteger(value)));
		if (!okType) {
			errors.push(`  - ${path || "/"}: expected ${types.join(" or ")}, received ${actual}`);
			return;
		}
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push(`  - ${path || "/"}: must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
	}
	if (Array.isArray(value) && schema.items) {
		value.forEach((v, i) => check(v, schema.items, `${path}/${i}`, errors));
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		for (const k of schema.required ?? []) {
			if (obj[k] === undefined) errors.push(`  - ${path}/${k}: required property is missing`);
		}
		for (const [k, sub] of Object.entries<Schema>(schema.properties ?? {})) {
			if (obj[k] !== undefined) check(obj[k], sub, `${path}/${k}`, errors);
		}
	}
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = coerce(structuredClone(toolCall.arguments), tool.parameters as Schema);
	const errors: string[] = [];
	check(args, tool.parameters as Schema, "", errors);
	if (errors.length === 0) return args;
	throw new Error(`Validation failed for tool "${toolCall.name}":\n${errors.join("\n")}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`);
}
