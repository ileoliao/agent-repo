/**
 * Vendored from pi (https://github.com/earendil-works/pi), packages/agent/src/stream-fn.ts, version 1.1.0.
 * Copyright (c) 2025 Mario Zechner. MIT License. See loop-runner/THIRD_PARTY_NOTICES.md.
 *
 * Adaptations for Loop Runner: none.
 */

import type { StreamFn } from "./types";

let defaultStreamFn: StreamFn | undefined;

/**
 * Configure the fallback used by Agent and low-level loops when callers omit streamFn.
 *
 * Hosts that provide a default model runtime can install its stream function here
 * without making pi-agent-core depend on a provider catalog or compatibility layer.
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
