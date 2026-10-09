import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const eslintSourceIdentitySchema = z.strictObject({
  path: z.string().min(1).max(8192),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
  sha256: hash,
});
export const eslintParticipationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceFingerprint: hash,
  configuration: eslintSourceIdentitySchema,
  files: z.array(eslintSourceIdentitySchema).min(1).max(256),
});
export type ESLintSourceIdentity = z.infer<typeof eslintSourceIdentitySchema>;
export type ESLintParticipationManifest = z.infer<
  typeof eslintParticipationManifestSchema
>;
const id = z.number().int().nonnegative().max(1023);
export const eslintParticipationTraceSchema = z.strictObject({
  complete: z.boolean(),
  events: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("preprocess"),
          id,
          input: eslintSourceIdentitySchema,
          outputs: z.array(eslintSourceIdentitySchema).max(1024),
        }),
        z.strictObject({
          kind: z.literal("parse"),
          input: eslintSourceIdentitySchema,
          successful: z.boolean(),
          activeRules: z.number().int().nonnegative().max(10000),
        }),
        z.strictObject({ kind: z.literal("postprocess"), id }),
      ]),
    )
    .max(3072),
});
export type ESLintParticipationTrace = z.infer<
  typeof eslintParticipationTraceSchema
>;
/** Reconcile the native depth-first block order, including repeated identical leaves. */
export function completeESLintParticipation(
  root: ESLintSourceIdentity,
  trace: ESLintParticipationTrace,
): boolean {
  if (!trace.complete || !trace.events.length) return false;
  const key = (node: ESLintSourceIdentity) =>
    JSON.stringify([node.path, node.bytes, node.sha256]);
  const frames: {
    id: number | null;
    nodes: ESLintSourceIdentity[];
    next: number;
  }[] = [{ id: null, nodes: [root], next: 0 }];
  const seen = new Set<number>();
  let parsed = 0;
  for (const event of trace.events) {
    const frame = frames.at(-1)!;
    if (event.kind === "postprocess") {
      if (frame.id !== event.id || frame.next !== frame.nodes.length)
        return false;
      frames.pop();
      continue;
    }
    const required = frame.nodes[frame.next];
    if (!required || key(required) !== key(event.input)) return false;
    frame.next++;
    if (event.kind === "parse") {
      if (event.activeRules === 0) return false;
      parsed++;
      continue;
    }
    if (seen.has(event.id) || !event.outputs.length) return false;
    seen.add(event.id);
    frames.push({ id: event.id, nodes: event.outputs, next: 0 });
  }
  return parsed > 0 && frames.length === 1 && frames[0]!.next === 1;
}
