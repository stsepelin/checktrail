import {
  copyInstalledPackages,
  qualifiedJavaScriptModules,
} from "./tool-fixture.js";

export const eslintConfig =
  "export default [{rules: {'no-debugger': 'error'}}];\n";
export const eslintPolicy = (project = ".") =>
  JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: project, checks: ["javascript.eslint"] }],
  });

export const copyESLint = (root: string): Promise<void> =>
  copyInstalledPackages(root, ["eslint"]);

/** Copy the frozen native profile independently of the development linter. */
export const copyESLintParticipation = (root: string): Promise<void> =>
  copyInstalledPackages(root, ["eslint"], qualifiedJavaScriptModules);
