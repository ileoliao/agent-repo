import { spawnSync } from "child_process";

/**
 * Harbor Mate stand-in for pi's `tools-manager`.
 *
 * Upstream downloads fd and ripgrep into pi's config directory. This extension
 * only uses a binary that is already on PATH, and never reaches the network.
 */
export async function ensureTool(tool: "fd" | "rg"): Promise<string | null> {
	const names =
		tool === "fd"
			? process.platform === "win32"
				? ["fd.exe", "fdfind.exe"]
				: ["fd", "fdfind"]
			: process.platform === "win32"
				? ["rg.exe"]
				: ["rg"];
	for (const name of names) {
		const result = spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true });
		if (!result.error && result.status === 0) return name;
	}
	return null;
}
