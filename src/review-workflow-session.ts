import {
  ReviewWorkflowEngine,
  type ReviewWorkflowOptions,
} from "./review-workflow.js";
import {
  ReviewWorkflowAudit,
  ReviewWorkflowAuditLimitError,
  captureReviewWorkflowCommand,
} from "./review-workflow-audit.js";
import type { ReviewWorkflowAuditOptions } from "./review-workflow-audit-schema.js";
import type {
  ReviewWorkflowAssignment,
  ReviewWorkflowSummary,
} from "./review-workflow-schema.js";
export interface ReviewWorkflowSessionOptions extends ReviewWorkflowOptions {
  audit?: ReviewWorkflowAuditOptions;
}
/** One command-only epoch; audited history is never passed to a worker or resumed. */
export class ReviewWorkflowSession {
  readonly #engine: ReviewWorkflowEngine;
  #audit: ReviewWorkflowAudit | undefined;
  #deferred:
    | {
        root: string;
        audit: ReviewWorkflowAuditOptions;
        engine: ReviewWorkflowOptions;
      }
    | undefined;
  #active = 0;
  #closing = false;
  #failure = false;
  #reason: "shutdown" | "audit-limit" = "shutdown";
  constructor(
    root: string,
    options: ReviewWorkflowSessionOptions,
    auditActivation: "startup" | "first-command" = "startup",
  ) {
    const { audit, ...engine } = options;
    this.#engine = new ReviewWorkflowEngine(root, engine);
    try {
      if (audit && auditActivation === "first-command") {
        ReviewWorkflowAudit.preflight(root, audit, engine);
        this.#deferred = {
          root,
          audit: structuredClone(audit),
          engine: structuredClone(engine),
        };
      } else
        this.#audit = audit
          ? new ReviewWorkflowAudit(root, audit, engine)
          : undefined;
    } catch (error) {
      this.#engine.dispose();
      throw error;
    }
  }
  #finalize(): void {
    if (this.#closing && !this.#active)
      this.#audit?.close(this.#engine.snapshots(), this.#reason);
  }
  dispose(): ReviewWorkflowSummary[] {
    this.#closing = true;
    this.#deferred = undefined;
    const result = this.#engine.dispose();
    this.#finalize();
    return result;
  }
  async command(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ReviewWorkflowAssignment | ReviewWorkflowSummary> {
    if (this.#closing || this.#failure)
      throw new Error("Workflow session is unavailable");
    if (this.#deferred) {
      try {
        const { root, audit, engine } = this.#deferred;
        this.#audit = new ReviewWorkflowAudit(root, audit, engine);
        this.#deferred = undefined;
      } catch (error) {
        this.#failure = true;
        this.dispose();
        throw error;
      }
    }
    if (!this.#audit) return this.#engine.command(input, signal);
    const captured = captureReviewWorkflowCommand(input);
    let commandId: string;
    try {
      commandId = this.#audit.begin(
        captured.capture,
        captured.operation,
        this.#engine.snapshots(),
      );
    } catch (error) {
      this.#failure = true;
      if (error instanceof ReviewWorkflowAuditLimitError)
        this.#reason = "audit-limit";
      this.dispose();
      throw error;
    }
    this.#active++;
    let result: ReviewWorkflowAssignment | ReviewWorkflowSummary | null = null;
    let operationError: unknown;
    let operationFailed = false;
    try {
      if (captured.capture.kind !== "complete")
        throw new Error("Workflow command exceeds JSON transport profile");
      result = await this.#engine.command(captured.value, signal);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let auditError: unknown;
    let auditFailed = false;
    try {
      this.#audit.finish(commandId, result, this.#engine.snapshots());
    } catch (error) {
      auditFailed = true;
      auditError = error;
      this.#failure = true;
      this.#closing = true;
      this.#engine.dispose();
    }
    this.#active--;
    try {
      this.#finalize();
    } catch (error) {
      auditFailed = true;
      auditError = error;
      this.#failure = true;
    }
    if (auditFailed) throw auditError;
    if (operationFailed) throw operationError;
    return result!;
  }
}
