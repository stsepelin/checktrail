import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import {
  eslintParticipationPins,
  eslintParticipationVersions,
} from "./eslint-participation-pins.js";
export async function eslintParticipationPrerequisites(
  root: string,
  entry: string,
) {
  const require = createRequire(entry);
  const arrayEntry = await withinRoot(
    root,
    path.relative(root, require.resolve("@eslint/config-array")),
  );
  const eslintDirectory = path.dirname(path.dirname(entry));
  const arrayDirectory = path.resolve(arrayEntry, "../../..");
  for (const [name, directory] of [
    ["eslint", eslintDirectory],
    ["@eslint/config-array", arrayDirectory],
  ] as const) {
    const file = await withinRoot(
      root,
      path.relative(root, path.join(directory, "package.json")),
    );
    const metadata = JSON.parse(await readFile(file, "utf8"));
    if (metadata.version !== eslintParticipationVersions[name])
      return {
        available: false as const,
        reason: "unsupported-version" as const,
      };
  }
  for (const pin of eslintParticipationPins) {
    const relative = pin.file.startsWith("eslint/")
      ? path.join(eslintDirectory, pin.file.slice("eslint/".length))
      : path.join(
          arrayDirectory,
          pin.file.slice("@eslint/config-array/".length),
        );
    const file = await withinRoot(root, path.relative(root, relative));
    const bytes = await readFile(file);
    if (
      bytes.length !== pin.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== pin.sha256
    )
      return {
        available: false as const,
        reason: "runtime-byte-mismatch" as const,
      };
  }
  return { available: true as const, arrayEntry };
}
