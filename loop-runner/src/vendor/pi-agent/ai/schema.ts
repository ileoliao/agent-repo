/**
 * Loop Runner describes tool arguments as plain JSON Schema objects (see tools.ts), so pi's TypeBox schema types are
 * replaced by these loose ones. Nothing is inferred from a schema; arguments are checked by validation.ts at run time.
 */
export type TSchema = Record<string, any>;
export type Static<_T = unknown> = any;
