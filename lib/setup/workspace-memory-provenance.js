/**
 * Provenance classification of workspace memory files for the OpenClaw host.
 *
 * Before injecting `MEMORY.md` and `USER.md` into a session, OpenClaw asks
 * the memory-slot owner to classify those paths
 * (`runtime.classifyWorkspaceMemoryPaths`). Without the method the host
 * answers `unsupported`, logs "excluding automatic memory context: selected
 * memory runtime does not support provenance classification" and drops both
 * files from the automatic context — the agent never sees its curated memory
 * unless it reads the file by hand.
 *
 * The rules below mirror OpenClaw's own `resolveMemoryPathClassification`
 * (memory-core) for the case without a recorded write ledger:
 * - paths outside the workspace, unreadable or non-memory files → `untrusted`
 * - `DREAMS.md` / `memory/dreaming/**` / `memory/.dreams/**` → `system`
 * - `MEMORY.md`, `memory.md`, `USER.md` and `memory/**.md` → `agent`
 * The host injects only `owner` and `agent` classes.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const ELIGIBLE_MEMORY_ORIGIN_CLASSES = Object.freeze(["owner", "agent"]);

const UNTRUSTED = Object.freeze({ curatedRoot: false, originClass: "untrusted" });

function isStrictlyInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * @param {{workspaceDir: string, absolutePath: string, source?: string}} params
 * @returns {Promise<{curatedRoot: boolean, originClass: "agent"|"system"|"untrusted"}>}
 */
export async function classifyWorkspaceMemoryPath(params = {}) {
  const source = params.source ?? "memory";
  if (source !== "memory") return UNTRUSTED;
  if (typeof params.workspaceDir !== "string" || !params.workspaceDir) return UNTRUSTED;
  if (typeof params.absolutePath !== "string" || !params.absolutePath) return UNTRUSTED;
  let workspacePath;
  let filePath;
  try {
    [workspacePath, filePath] = await Promise.all([
      fs.realpath(params.workspaceDir),
      fs.realpath(params.absolutePath),
    ]);
  } catch {
    return UNTRUSTED;
  }
  if (!isStrictlyInside(workspacePath, filePath)) return UNTRUSTED;
  const segments = path.relative(workspacePath, filePath).split(path.sep);
  const curatedRoot = segments.length === 1
    && (segments[0] === "MEMORY.md" || segments[0] === "memory.md" || segments[0] === "USER.md");
  const isDreamFile = segments.length === 1 && (segments[0] === "DREAMS.md" || segments[0] === "dreams.md");
  const isDreamDir = segments[0] === "memory" && (segments[1] === "dreaming" || segments[1] === ".dreams");
  if (isDreamFile || isDreamDir) return { curatedRoot, originClass: "system" };
  const isWorkspaceMemory = curatedRoot
    || (segments[0] === "memory" && segments.at(-1)?.endsWith(".md") === true);
  return { curatedRoot, originClass: isWorkspaceMemory ? "agent" : "untrusted" };
}

/**
 * Host contract: returns one `{relativePath, originClass}` per input path,
 * in input order. Never throws for a single bad path.
 * @param {{workspaceDir?: string, relativePaths?: string[]}} params
 * @returns {Promise<Array<{relativePath: string, originClass: string}>>}
 */
export async function classifyWorkspaceMemoryPaths(params = {}) {
  const workspaceDir = typeof params.workspaceDir === "string" ? params.workspaceDir : "";
  const relativePaths = Array.isArray(params.relativePaths) ? params.relativePaths : [];
  return Promise.all(relativePaths.map(async (relativePath) => {
    if (!workspaceDir || typeof relativePath !== "string" || !relativePath) {
      return { relativePath, originClass: "untrusted" };
    }
    const { originClass } = await classifyWorkspaceMemoryPath({
      workspaceDir,
      absolutePath: path.resolve(workspaceDir, relativePath),
      source: "memory",
    });
    return { relativePath, originClass };
  }));
}
