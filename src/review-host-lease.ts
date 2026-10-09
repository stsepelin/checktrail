import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowResponseSchema,
  type ReviewWorkflowAssignment,
  type ReviewWorkflowResponse,
} from "./review-workflow-schema.js";
import { VERSION } from "./types.js";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const reviewHostLeaseOptionsSchema = z.strictObject({
  allowSourceDisclosure: z.boolean(),
  maxReads: z.number().int().min(1).max(32).default(1),
  maxPacketBytes: z.number().int().min(0).max(8_388_608).default(1_048_576),
  maxResponseBytes: z.number().int().min(0).max(262_144).default(131_072),
  wallMs: z.number().int().min(1).max(120_000).default(30_000),
});
export const reviewHostLeaseSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("review-host-lease-summary"),
  assignmentId: z.string().uuid(),
  assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  stage: z.enum(["reviewer", "refuter", "adjudicator"]),
  state: z.enum(["issued", "submitted", "revoked"]),
  sourceAccessRevoked: z.boolean(),
  reads: z.number().int().nonnegative().max(32),
  responseDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sourceIncluded: z.literal(false),
  hostProvenance: z.literal("host-declared-unverified"),
  hostIsolationVerified: z.literal(false),
  modelFreshnessVerified: z.literal(false),
  claimsVerified: z.literal(false),
});
/** A startup-scoped data lease, not a host launcher or proof of model isolation. */
export class ReviewHostAssignmentLease {
  readonly #options: z.infer<typeof reviewHostLeaseOptionsSchema>;
  readonly #binding: Pick<
    ReviewWorkflowAssignment,
    "assignmentId" | "assignmentDigest" | "stage"
  >;
  readonly #deadline: number;
  #assignment: ReviewWorkflowAssignment | undefined;
  #response: ReviewWorkflowResponse | undefined;
  #responseDigest: string | null = null;
  #reads = 0;
  #timer: NodeJS.Timeout | undefined;
  #state: "issued" | "submitted" | "revoked" = "issued";
  constructor(input: unknown, options: unknown) {
    this.#options = reviewHostLeaseOptionsSchema.parse(options);
    if (!this.#options.allowSourceDisclosure)
      throw new Error("Host lease requires operator source disclosure");
    const assignment = reviewWorkflowAssignmentSchema.parse(input);
    const { assignmentDigest, ...body } = assignment;
    if (digest(JSON.stringify(body)) !== assignmentDigest)
      throw new Error("Host assignment digest differs");
    if (
      Buffer.byteLength(JSON.stringify(assignment)) >
      this.#options.maxPacketBytes
    )
      throw new Error("Host assignment exceeds operator packet limit");
    this.#binding = {
      assignmentId: assignment.assignmentId,
      assignmentDigest,
      stage: assignment.stage,
    };
    this.#assignment = structuredClone(assignment);
    this.#deadline = performance.now() + this.#options.wallMs;
    this.#timer = setTimeout(() => this.revoke(), this.#options.wallMs);
    this.#timer.unref();
  }
  #expire(): void {
    if (this.#state === "issued" && performance.now() >= this.#deadline)
      this.revoke();
  }
  read(): ReviewWorkflowAssignment {
    this.#expire();
    if (!this.#assignment || this.#state !== "issued")
      throw new Error("Host source lease is unavailable");
    if (this.#reads >= this.#options.maxReads) {
      this.revoke();
      throw new Error("Host source read limit reached");
    }
    this.#reads++;
    return structuredClone(this.#assignment);
  }
  submit(input: unknown): z.infer<typeof reviewHostLeaseSummarySchema> {
    this.#expire();
    if (!this.#assignment || this.#state !== "issued")
      throw new Error("Host source lease is unavailable");
    // Every reached submission consumes this lease, including malformed or foreign responses.
    this.#assignment = undefined;
    this.#state = "revoked";
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const serialized = JSON.stringify(input);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized) > this.#options.maxResponseBytes
    )
      throw new Error("Host response exceeds operator limit");
    const response = reviewWorkflowResponseSchema.parse(input);
    // Timer callbacks cannot run while synchronous response validation is active.
    if (performance.now() >= this.#deadline)
      throw new Error("Host lease deadline reached during submission");
    if (
      response.assignmentId !== this.#binding.assignmentId ||
      response.assignmentDigest !== this.#binding.assignmentDigest
    )
      throw new Error("Host response belongs to another assignment");
    if (this.#reads === 0) throw new Error("Host assignment was not delivered");
    this.#response = structuredClone(response);
    this.#responseDigest = digest(JSON.stringify(response));
    this.#assignment = undefined;
    this.#state = "submitted";
    clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.summary();
  }
  /** The operator forwards the unmodified response to its owning workflow once. */
  takeSubmission(): ReviewWorkflowResponse {
    if (!this.#response || this.#state !== "submitted")
      throw new Error("Host submission is unavailable");
    const response = this.#response;
    this.#response = undefined;
    return structuredClone(response);
  }
  revoke(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#assignment = undefined;
    this.#response = undefined;
    if (this.#state !== "submitted") this.#state = "revoked";
  }
  summary(): z.infer<typeof reviewHostLeaseSummarySchema> {
    this.#expire();
    return reviewHostLeaseSummarySchema.parse({
      schemaVersion: 1,
      format: "review-host-lease-summary",
      ...this.#binding,
      state: this.#state,
      sourceAccessRevoked: this.#assignment === undefined,
      reads: this.#reads,
      responseDigest: this.#responseDigest,
      sourceIncluded: false,
      hostProvenance: "host-declared-unverified",
      hostIsolationVerified: false,
      modelFreshnessVerified: false,
      claimsVerified: false,
    });
  }
}
/** The server exposes one issued packet and one response; no filesystem or workflow control tools. */
export function createReviewHostAssignmentServer(
  lease: ReviewHostAssignmentLease,
): McpServer {
  let used = false;
  const server = new (class extends McpServer {
    override async close(): Promise<void> {
      if (used && lease.summary().state === "issued") lease.revoke();
      await super.close();
    }
  })({ name: "checktrail-review-host-assignment", version: VERSION });
  const priorClose = server.server.onclose;
  server.server.onclose = () => {
    if (used && lease.summary().state === "issued") lease.revoke();
    priorClose?.();
  };
  const failure = () => ({
    isError: true,
    content: [
      { type: "text" as const, text: "Host assignment request rejected" },
    ],
  });
  server.registerTool(
    "review_host_assignment",
    {
      description:
        "Read the one startup-assigned advisory packet. No other source, stage or history is accessible through this server.",
      inputSchema: z.strictObject({}),
      outputSchema: reviewWorkflowAssignmentSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      used = true;
      try {
        const value = lease.read();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch {
        return failure();
      }
    },
  );
  server.registerTool(
    "review_host_submit",
    {
      description:
        "Submit one unverified response to the issued assignment and revoke further source access. Metadata remains host-declared.",
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: reviewHostLeaseSummarySchema,
      annotations: { readOnlyHint: false },
    },
    async (response) => {
      used = true;
      try {
        const value = lease.submit(response);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch {
        return failure();
      }
    },
  );
  server.registerTool(
    "review_host_status",
    {
      description:
        "Inspect source-free lease accounting. This never verifies the host, model or claims.",
      inputSchema: z.strictObject({}),
      outputSchema: reviewHostLeaseSummarySchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const value = lease.summary();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    },
  );
  return server;
}
