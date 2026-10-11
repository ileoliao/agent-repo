/**
 * Minimal stand-in for the `typebox` package pi's tool schemas import.
 *
 * Loop Runner does not publish these schemas to the model (it keeps its own tool
 * contract). The shim only has to build the objects the vendored modules construct
 * at load time, so the extension does not depend on typebox.
 */

// pi uses this to infer tool argument types from schemas. The shim does not replicate that.
export type Static<T> = any;

export interface TSchema {
	type?: string;
	description?: string;
	properties?: Record<string, TSchema>;
	required?: string[];
	items?: TSchema;
	anyOf?: TSchema[];
	const?: unknown;
	optional?: boolean;
}

function withDesc(schema: TSchema, opts?: { description?: string }): TSchema {
	if (opts?.description) schema.description = opts.description;
	return schema;
}

export const Type = {
	String: (opts?: { description?: string }): TSchema => withDesc({ type: "string" }, opts),
	Number: (opts?: { description?: string }): TSchema => withDesc({ type: "number" }, opts),
	Boolean: (opts?: { description?: string }): TSchema => withDesc({ type: "boolean" }, opts),
	Literal: (value: string): TSchema => ({ const: value, type: "string" }),
	Optional: (schema: TSchema): TSchema => ({ ...schema, optional: true }),
	Array: (items: TSchema, opts?: { description?: string }): TSchema => withDesc({ type: "array", items }, opts),
	Union: (anyOf: TSchema[]): TSchema => ({ anyOf }),
	Object: (properties: Record<string, TSchema>, _opts?: object): TSchema => ({
		type: "object",
		properties,
		required: Object.entries(properties)
			.filter(([, schema]) => !schema.optional)
			.map(([key]) => key),
	}),
};
