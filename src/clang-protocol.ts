import path from "node:path";

export function clangVersion(output: string): string | undefined {
  return /^(?:Apple |Debian |Ubuntu |Alpine )?clang version (\d+\.\d+\.\d+)(?:[^\r\n]*)\r?\nTarget: [^\r\n]+\r?\nThread model: posix\r?\nInstalledDir: [^\r\n]+$/.exec(
    output.trim(),
  )?.[1];
}

export function supportedClangVersion(output: string): boolean {
  return (
    (clangVersion(output) === "21.0.0" &&
      output.startsWith("Apple clang version 21.0.0 (clang-2100.3.34.2)\n")) ||
    (clangVersion(output) === "22.1.3" &&
      output.startsWith("Alpine clang version 22.1.3\n"))
  );
}

export function clangDependencies(text: string, cwd: string): string[] {
  const flattened = text.replace(/\\\r?\n/g, "").trim();
  if (!flattened.startsWith("checktrail: "))
    throw new Error("Missing native dependency target");
  const body = flattened.slice("checktrail: ".length);
  if (/[\r\n$#:]/.test(body) || body.replaceAll("\\ ", "").includes("\\"))
    throw new Error("Unsupported dependency-file spelling");
  const paths = body
    .split(/(?<!\\)[ \t]+/)
    .filter(Boolean)
    .map((word) => path.resolve(cwd, word.replaceAll("\\ ", " ")));
  if (!paths.length) throw new Error("Native dependency list is empty");
  return [...new Set(paths)].sort();
}
