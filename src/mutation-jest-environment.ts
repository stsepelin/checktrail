import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import type { Circus } from "@jest/types";
import type {
  JestEnvironmentConfig,
  EnvironmentContext,
} from "@jest/environment";
const entry = process.env.CHECKTRAIL_MUTATION_JEST_ENTRY,
  hooks = process.env.CHECKTRAIL_MUTATION_JEST_HOOKS;
if (!entry || !hooks)
  throw Error("Owned mutation environment transport missing");
const { TestEnvironment } = createRequire(entry)(
  "jest-environment-node",
) as typeof import("jest-environment-node");
export default class MutationEnvironment extends TestEnvironment {
  private readonly testPath: string;
  constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
    super(config, context);
    this.testPath = context.testPath;
  }
  handleTestEvent(event: Circus.Event): void {
    if (event.name === "hook_failure")
      appendFileSync(
        hooks!,
        JSON.stringify({
          file: this.testPath,
          name: event.hook.type,
          test: event.test?.name ?? null,
        }) + "\n",
      );
  }
}
