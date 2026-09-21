import type { Check, Project } from "./types.js";

export function swiftCheck(project: Project): Check {
  const files = project.files.filter((file) => file.endsWith(".swift"));
  return {
    id: "swift.syntax",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "syntax",
    parser: "silent-syntax",
    commands: files.map((file) => ({
      executable: "swiftc",
      args: ["-frontend", "-parse", "-no-color-diagnostics", `./${file}`],
      cwd: project.path,
    })),
    reason:
      "Parse inventoried Swift files directly without evaluating the SwiftPM manifest; this does not type-check, resolve dependencies or run tests.",
    ...(!files.length
      ? { unavailableReason: "No Swift source was inventoried." }
      : {}),
  };
}
