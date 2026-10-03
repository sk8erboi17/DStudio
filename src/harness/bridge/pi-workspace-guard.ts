// DStudio: confine pi's file tools to the DStudio workspace (DSTUDIO_WORKSPACE).
//
// read, write, edit, grep, find and ls paths are resolved as pi resolves them
// (leading "@" removed, Unicode spaces normalized, "~" expanded, relative to
// the working directory). The nearest existing ancestor is then realpath'd,
// so a symlink inside the workspace cannot lead a call outside it. A blocked
// call returns its reason to the model; nothing is executed. bash is not
// confined, exactly as in DStudio's native Agent and in opencode.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const UNICODE_SPACES = /[  -   　]/g;

export function resolveLikePi(given: string, cwd: string): string {
	let path = given.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export function realTarget(target: string): string {
	let probe = target;
	const tail: string[] = [];
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) break;
		tail.unshift(basename(probe));
		probe = parent;
	}
	return join(realpathSync(probe), ...tail);
}

export default function (pi: ExtensionAPI) {
	const root = process.env.DSTUDIO_WORKSPACE;
	if (!root) throw new Error("DSTUDIO_WORKSPACE is required by the DStudio workspace guard");
	const workspace = realpathSync(root);
	const inside = (path: string) => path === workspace || path.startsWith(workspace + sep);
	pi.on("tool_call", async (event) => {
		if (!FILE_TOOLS.has(event.toolName)) return undefined;
		const raw = (event.input as { path?: unknown }).path;
		const given = typeof raw === "string" && raw.trim() ? raw : ".";
		if (inside(realTarget(resolveLikePi(given, process.cwd())))) return undefined;
		return { block: true, reason: `DStudio confines ${event.toolName} to the workspace ${workspace}; ${given} is outside it` };
	});
}
