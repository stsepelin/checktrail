export function vitestMajor(metadata: unknown): 4 | 5 {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    metadata.name !== "vitest" ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    !/^[45]\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(metadata.version)
  )
    throw new Error(
      "Unsupported Vitest package: stable Vitest 4 or 5 is required",
    );
  return metadata.version.startsWith("4.") ? 4 : 5;
}
