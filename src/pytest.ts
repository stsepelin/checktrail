import { pytestRunner } from "./pytest-runner.js";
import type { Check, Project } from "./types.js";

export function pytestCheck(project: Project): Check {
  const files = project.files.filter((file) =>
    /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(file),
  );
  const check: Check = {
    id: "python.pytest",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "test",
    parser: "pytest-json",
    commands: [
      {
        executable: "python3",
        args: ["-c", pytestRunner, ...files],
        cwd: project.path,
        env: { PYTHONDONTWRITEBYTECODE: "1" },
      },
    ],
    reason:
      "Run pytest against every planned candidate and reconcile collected items with setup/call/teardown events.",
  };
  if (!files.length)
    check.unavailableReason =
      "No test_*.py or *_test.py files were inventoried.";
  return check;
}
