import { createHash } from "node:crypto";
import { z } from "zod";

export const environmentName = z
  .string()
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/);
const environmentSchema = z
  .record(
    environmentName,
    z
      .string()
      .max(16_384)
      .refine((value) => !value.includes("\0")),
  )
  .refine((value) => Object.keys(value).length <= 64);

export function operatorEnvironment(
  input: Record<string, string> = {},
): Record<string, string> {
  return environmentSchema.parse(input);
}

export function inheritEnvironment(
  names: string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate environment permission");
  return operatorEnvironment(
    Object.fromEntries(
      names.map((name) => {
        environmentName.parse(name);
        if (!Object.hasOwn(source, name) || source[name] === undefined)
          throw new Error(`Allowed environment variable is unset: ${name}`);
        return [name, source[name]!];
      }),
    ),
  );
}

export function selectEnvironment(
  names: string[],
  supplied: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    names
      .filter((name) => Object.hasOwn(supplied, name))
      .sort()
      .map((name) => [name, supplied[name]!]),
  );
}

export function environmentFingerprint(
  environment: Record<string, string>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment).sort(([a], [b]) =>
          a.localeCompare(b, "en"),
        ),
      ),
    )
    .digest("hex");
}
