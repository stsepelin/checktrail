import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
const nativeProcIo = {
  readText: (file: string) => readFile(file, "utf8"),
  readLink: (file: string) => readlink(file),
};
/** A rejected/unreadable PID is not evidence that the target process was reached. */
export async function readNativeProcCommand(
  pid: string,
  executable: string,
  io = nativeProcIo,
): Promise<string[] | null> {
  try {
    const args = (await io.readText(`/proc/${pid}/cmdline`)).split("\0");
    if (args[0] !== executable && args[0] !== path.basename(executable))
      return null;
    if ((await io.readLink(`/proc/${pid}/exe`)) !== executable) return null;
    return args;
  } catch (error) {
    if (
      ["ENOENT", "ESRCH", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return null;
    throw error;
  }
}
