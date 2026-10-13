/**
 * Minimal stand-ins for `@earendil-works/pi-agent-core` AgentTool and pi's
 * extension ToolDefinition. Harbor Mate calls the tool execute functions directly
 * and does not load the agent runtime or the TUI.
 */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ExtensionContext {
	cwd?: string;
	model?: {
		provider?: string;
		id?: string;
		input?: string[];
		inputLimits?: { images?: { resize?: unknown } };
	};
	sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
	thinkingLevel?: string;
}

export type ExtensionToolContext = ExtensionContext;

export interface ToolDefinition<TParams = unknown, TDetails = unknown, _TState = unknown> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	parameters: TParams;
	outputSchema?: unknown;
	constrainedSampling?: unknown;
	executionMode?: string;
	renderShell?: string;
	prepareArguments?: (input: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: (update: unknown) => void,
		ctx?: ExtensionContext,
	) => Promise<{ content: TextContent[]; details?: TDetails; structuredContent?: unknown; isError?: boolean }>;
}

export interface AgentTool<TParams = unknown, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	outputSchema?: unknown;
	constrainedSampling?: unknown;
	prepareArguments?: (input: unknown) => unknown;
	executionMode?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: (update: unknown) => void,
		ctx?: ExtensionToolContext,
	) => Promise<{ content: TextContent[]; details?: TDetails; structuredContent?: unknown; isError?: boolean }>;
}
