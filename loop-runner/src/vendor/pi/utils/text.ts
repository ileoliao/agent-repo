/**
 * Vendored from pi (https://github.com/earendil-works/pi).
 * Copyright (c) 2025 Mario Zechner. MIT License. See loop-runner/THIRD_PARTY_NOTICES.md.
 * Source: packages/coding-agent/src/utils/text.ts
 * Commit: ea448f454af474f3e2fe9733b331e17b0662f5d6
 */
/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return splitBom(content).text;
}
