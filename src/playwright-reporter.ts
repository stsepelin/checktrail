import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestError,
} from "@playwright/test/reporter";
import { stripVTControlCharacters } from "node:util";

const message = (error: TestError): string =>
  stripVTControlCharacters(
    error.message ?? error.value ?? "Unknown Playwright error",
  );

export default class EvidenceReporter implements Reporter {
  private suite?: Suite;
  private errors: string[] = [];
  private projects: string[] = [];
  onBegin(config: FullConfig, suite: Suite): void {
    this.suite = suite;
    this.projects = config.projects.map((project) => project.name);
  }
  onError(error: TestError): void {
    this.errors.push(message(error));
  }
  onEnd(result: FullResult): void {
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        status: result.status,
        errors: this.errors,
        projects: this.projects,
        tests:
          this.suite?.allTests().map((test) => ({
            id: test.id,
            file: test.location.file,
            project: test.parent.project()?.name,
            expectedStatus: test.expectedStatus,
            outcome: test.outcome(),
            results: test.results.map((attempt) => ({
              status: attempt.status,
              retry: attempt.retry,
              errors: attempt.errors.map(message),
            })),
          })) ?? [],
      })}\n`,
    );
  }
  printsToStdio(): boolean {
    return true;
  }
}
