import type { parseCommandLine } from "typescript";

export function typecheckArguments(
  compiler: { parseCommandLine: typeof parseCommandLine },
  args: string[],
): string[] {
  const probe = compiler.parseCommandLine(["--noCheck", "false"]);
  if (probe.errors.length === 0 && probe.options.noCheck === false)
    return [...args, "--noCheck", "false"];
  if (
    probe.errors.length === 1 &&
    probe.errors[0]!.code === 5023 &&
    probe.options.noCheck === undefined
  )
    return args;
  throw new Error("Cannot establish the compiler's noCheck option support");
}
