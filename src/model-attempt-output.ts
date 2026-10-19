import { createHash } from "node:crypto";
import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const modelAttemptOutputSchema = z.strictObject({
  attemptId: z.string().uuid(),
  requestSha256: digest,
  httpStatus: z.number().int().min(100).max(599).nullable(),
  observedBodyBytes: count,
  retainedBodyBytes: count,
  bodyState: z.enum([
    "complete",
    "withheld-credential",
    "withheld-uninspectable",
    "withheld-incomplete",
    "unobserved",
  ]),
  bodySha256: digest.nullable(),
  bodyBase64: z
    .string()
    .max(4 * Math.ceil(1048576 / 3))
    .nullable(),
});
export type ModelAttemptOutput = z.infer<typeof modelAttemptOutputSchema>;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
type ModelJsonInspection =
  "complete" | "withheld-credential" | "withheld-uninspectable";
function inspectModelJson(
  parsed: unknown,
  credentials: readonly string[],
): ModelJsonInspection {
  const pending: unknown[] = [parsed];
  let inspected = 0;
  while (pending.length) {
    if (++inspected > 100000) return "withheld-uninspectable";
    const item = pending.pop();
    if (
      typeof item === "string" &&
      credentials.some((value) => item.includes(value))
    )
      return "withheld-credential";
    if (Array.isArray(item)) {
      if (item.length + pending.length > 100000)
        return "withheld-uninspectable";
      for (const value of item) pending.push(value);
    } else if (item !== null && typeof item === "object")
      for (const [key, value] of Object.entries(item)) pending.push(key, value);
  }
  return "complete";
}
export class ModelAttemptOutputCapture {
  #chunks: Buffer[] = [];
  #retained = 0;
  #observed = 0;
  #complete = false;
  #status: number | null = null;
  #credentials: readonly string[];
  #decodedBodyState: Exclude<ModelJsonInspection, "complete"> | null = null;
  constructor(
    readonly attemptId: string,
    readonly requestSha256: string,
    readonly maximum: number,
    credentials: readonly string[],
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1048576)
      throw new Error("Invalid model response capture limit");
    if (!credentials.length || credentials.some((value) => !value.length))
      throw new Error("Model response capture requires nonempty credentials");
    this.#credentials = [...credentials];
  }
  inspectDecodedJson(value: unknown): boolean {
    const state = inspectModelJson(value, this.#credentials);
    if (
      state !== "complete" &&
      (this.#decodedBodyState === null || state === "withheld-credential")
    )
      this.#decodedBodyState = state;
    return this.#decodedBodyState === null;
  }
  status(value: number) {
    this.#status = value >= 100 && value <= 599 ? value : null;
  }
  observe(bytes: Uint8Array) {
    this.#observed += bytes.byteLength;
    const keep = Math.min(bytes.byteLength, this.maximum - this.#retained);
    if (keep > 0) {
      this.#chunks.push(Buffer.from(bytes.subarray(0, keep)));
      this.#retained += keep;
    }
  }
  complete() {
    this.#complete = true;
  }
  snapshot(): ModelAttemptOutput {
    const base = {
      attemptId: this.attemptId,
      requestSha256: this.requestSha256,
      httpStatus: this.#status,
      observedBodyBytes: this.#observed,
      retainedBodyBytes: 0,
      bodySha256: null,
      bodyBase64: null,
    };
    if (!this.#observed)
      return modelAttemptOutputSchema.parse({
        ...base,
        bodyState: "unobserved",
      });
    if (!this.#complete || this.#retained !== this.#observed)
      return modelAttemptOutputSchema.parse({
        ...base,
        bodyState: "withheld-incomplete",
      });
    const bytes = Buffer.concat(this.#chunks);
    if (this.#credentials.some((value) => bytes.includes(Buffer.from(value))))
      return modelAttemptOutputSchema.parse({
        ...base,
        bodyState: "withheld-credential",
      });
    if (this.#decodedBodyState !== null)
      return modelAttemptOutputSchema.parse({
        ...base,
        bodyState: this.#decodedBodyState,
      });
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return modelAttemptOutputSchema.parse({
        ...base,
        bodyState: "withheld-uninspectable",
      });
    }
    const state = inspectModelJson(parsed, this.#credentials);
    if (state !== "complete")
      return modelAttemptOutputSchema.parse({ ...base, bodyState: state });
    return modelAttemptOutputSchema.parse({
      ...base,
      bodyState: "complete",
      retainedBodyBytes: bytes.length,
      bodySha256: hash(bytes),
      bodyBase64: bytes.toString("base64"),
    });
  }
}
export function parseModelAttemptOutput(input: unknown): ModelAttemptOutput {
  const value = modelAttemptOutputSchema.parse(input);
  if (value.bodyState === "complete") {
    if (
      value.bodyBase64 === null ||
      value.bodySha256 === null ||
      value.httpStatus === null
    )
      throw new Error("Complete model body requires its physical observation");
    const bytes = Buffer.from(value.bodyBase64, "base64");
    if (
      bytes.toString("base64") !== value.bodyBase64 ||
      bytes.length !== value.retainedBodyBytes ||
      bytes.length !== value.observedBodyBytes ||
      hash(bytes) !== value.bodySha256
    )
      throw new Error("Model response body bytes and digest disagree");
  } else if (
    value.bodyBase64 !== null ||
    value.bodySha256 !== null ||
    value.retainedBodyBytes !== 0
  )
    throw new Error("Withheld model response cannot retain body content");
  if ((value.bodyState === "unobserved") !== (value.observedBodyBytes === 0))
    throw new Error(
      "Model response observation state disagrees with byte counts",
    );
  return value;
}
