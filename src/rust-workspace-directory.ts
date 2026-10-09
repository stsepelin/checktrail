import { realpath, stat } from "node:fs/promises";
import path from "node:path";
// Only the engine supplies this value for a temporaryDirectory command.
// Normalization does not grant trust or accept an MCP-selected directory.
export async function rustWorkspaceTemporaryBase(
  value: string | undefined,
): Promise<string> {
  if (!value || !path.isAbsolute(value))
    throw Error("Rust workspace needs its engine-owned temporary directory");
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory())
    throw Error("Rust workspace needs its engine-owned temporary directory");
  return canonical;
}
