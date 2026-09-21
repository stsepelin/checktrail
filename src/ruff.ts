import type { Check, Command, Project } from "./types.js";

export function ruffCheck(project: Project): Check {
  const files = project.files.filter((file) => /\.pyi?$/.test(file));
  const base = [
    "check",
    "--no-cache",
    "--no-fix",
    "--no-fix-only",
    "--no-unsafe-fixes",
    "--force-exclude",
    "--output-format",
    "json",
  ];
  const command = (args: string[]): Command => ({
    executable: "ruff",
    args: [...base, ...args],
    cwd: project.path,
  });
  const literalFiles = files.map((file) => `./${file}`);
  const check: Check = {
    id: "python.ruff",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "ruff-json",
    commands: [
      command(["--show-files", "--", ...literalFiles]),
      ...literalFiles.map((file) => command(["--show-settings", "--", file])),
      command(["--", ...literalFiles]),
    ],
    reason:
      "Run installed Ruff without fixes and require native file-selection, enabled-rule and JSON diagnostic evidence.",
  };
  if (!files.length)
    check.unavailableReason =
      "No Python source or stub files were inventoried.";
  else if (files.some((file) => /[\r\n]/.test(file)))
    check.unavailableReason =
      "Ruff file-list evidence cannot account for filenames containing newlines.";
  return check;
}
