import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function phpunitCheck(
  source: Inventory,
  project: Project,
  pest = false,
): Promise<Check> {
  const files = project.files.filter((file) => file.endsWith("Test.php"));
  const tool = await localTool(
    source.root,
    project.path,
    pest ? "pestphp/pest/bin/pest" : "phpunit/phpunit/phpunit",
    "vendor",
  );
  const configuration = ["phpunit.xml", "phpunit.xml.dist"].find((file) =>
    project.files.includes(file),
  );
  const name = pest ? "Pest" : "PHPUnit";
  const check: Check = {
    id: pest ? "php.pest" : "php.phpunit",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "test",
    parser: "phpunit-junit",
    commands: tool
      ? [
          {
            executable: "php",
            args: [
              tool,
              ...(pest
                ? [
                    "--ci",
                    "--no-tia",
                    "--colors=never",
                    "--configuration",
                    `./${configuration ?? "phpunit.xml"}`,
                  ]
                : []),
              "--no-output",
              "--do-not-record-test-run-history",
              "--no-logging",
              "--log-junit",
              pest ? "php://stderr" : "php://stdout",
              "--all",
              "--fail-on-empty-test-suite",
              "--fail-on-risky",
              "--fail-on-warning",
              ...(pest ? [] : ["--"]),
              ...files.map((file) => `./${file}`),
            ],
            cwd: project.path,
          },
        ]
      : [],
    reason: `Run ${name} with fresh JUnit output, exact test-file accounting and positive native assertion evidence.`,
  };
  if (!files.length)
    check.unavailableReason = "No *Test.php files were inventoried.";
  else if (!tool)
    check.unavailableReason = `${name} is not installed in vendor within the configured root.`;
  else if (pest && !configuration)
    check.unavailableReason =
      "Pest requires a local phpunit.xml or phpunit.xml.dist to avoid generating configuration.";
  else if (pest && files.some((file) => file.includes("::")))
    check.unavailableReason =
      "Pest JUnit cannot disambiguate a test path containing ::.";
  return check;
}
