import { z } from "zod";
const text = z.string();
const hash = text.regex(/^[a-f0-9]{64}$/);
export const laravelLegacyAttributeSchemas = {
  routes: z.strictObject({
    domain: text.nullable(),
    method: text.min(1),
    uri: text.min(1),
    name: text.nullable(),
    handler: text.min(1),
    middleware: z.array(text),
    constraintsHash: hash,
    defaultsHash: hash,
  }),
  middleware: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.enum(["global", "priority"]),
      stack: z.array(text),
    }),
    z.strictObject({
      type: z.literal("group"),
      name: text,
      stack: z.array(text),
    }),
    z.strictObject({ type: z.literal("alias"), name: text, target: text }),
  ]),
  listeners: z.strictObject({
    type: z.enum(["exact", "wildcard"]),
    event: text,
    listener: text,
  }),
  schedules: z.strictObject({
    type: z.enum(["callback", "command"]),
    target: text,
    expression: text,
    repeatSeconds: z.number().int().nullable(),
    user: text.nullable(),
    environments: z.array(text),
    evenInMaintenanceMode: z.boolean(),
    evenWhenPaused: z.boolean(),
    withoutOverlapping: z.boolean(),
    releaseOnTerminationSignals: z.boolean(),
    onOneServer: z.boolean(),
    expiresAt: z.number().int(),
    runInBackground: z.boolean(),
    description: text.nullable(),
    output: text,
    shouldAppendOutput: z.boolean(),
    timezone: text.nullable(),
    parametersHash: hash,
    filters: z.array(text),
    rejects: z.array(text),
    beforeCallbacks: z.array(text),
    afterCallbacks: z.array(text),
    mutex: text,
    mutexNameResolver: text.nullable(),
    attributesHash: hash,
  }),
  bindings: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("factory"),
      abstract: text,
      target: text,
      shared: z.boolean(),
      scoped: z.boolean(),
    }),
    z.strictObject({
      type: z.enum(["alias", "instance"]),
      abstract: text,
      target: text,
    }),
    z.strictObject({
      type: z.literal("contextual"),
      consumer: text,
      abstract: text,
      target: text,
    }),
  ]),
};
