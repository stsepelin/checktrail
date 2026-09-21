import path from "node:path";
import type { Check, Project } from "./types.js";

export function rubyCheck(project: Project): Check {
  const files = project.files.filter(
    (file) =>
      /\.(?:rb|rake|gemspec)$/.test(file) ||
      ["Gemfile", "Rakefile"].includes(path.posix.basename(file)),
  );
  return {
    id: "ruby.syntax",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "syntax",
    parser: "ruby-syntax",
    commands: files.map((file) => ({
      executable: "ruby",
      args: ["--disable-gems", "-c", `./${file}`],
      cwd: project.path,
      env: { RUBYOPT: "" },
    })),
    reason:
      "Parse each inventoried Ruby source and Ruby DSL manifest with gem loading disabled; this is syntax evidence, not runtime or test coverage.",
    ...(!files.length
      ? {
          unavailableReason:
            "No Ruby source or supported Ruby DSL manifest was inventoried.",
        }
      : {}),
  };
}
