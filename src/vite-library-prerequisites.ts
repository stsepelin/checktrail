import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { withinRoot } from "./inventory.js";
import { viteLibraryPins, viteLibraryBindings } from "./vite-library-pins.js";
export async function viteLibraryPrerequisites(
  root: string,
  entry: string,
  compiler: string,
) {
  const require = createRequire(entry);
  const directories: Record<string, string> = {
    vite: path.resolve(entry, "../../.."),
    typescript: path.resolve(compiler, "../.."),
    rolldown: path.dirname(require.resolve("rolldown/package.json")),
  };
  for (const [name, version] of Object.entries({
    vite: "8.3.0",
    rolldown: "1.2.9",
    typescript: "6.0.3",
  })) {
    const metadata = JSON.parse(
      await readFile(
        await withinRoot(
          root,
          path.relative(root, path.join(directories[name]!, "package.json")),
        ),
        "utf8",
      ),
    );
    if (metadata.version !== version)
      return { available: false as const, reason: "unsupported-version" };
  }
  for (const pin of viteLibraryPins) {
    const bytes = await readFile(
      await withinRoot(
        root,
        path.relative(root, path.join(directories[pin.package]!, pin.file)),
      ),
    );
    if (
      bytes.length !== pin.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== pin.sha256
    )
      return { available: false as const, reason: "runtime-byte-mismatch" };
  }
  const platform =
    process.platform === "darwin" && process.arch === "arm64"
      ? "@rolldown/binding-darwin-arm64"
      : process.platform === "linux" &&
          process.arch === "arm64" &&
          !(
            process.report.getReport() as {
              header?: { glibcVersionRuntime?: string };
            }
          ).header?.glibcVersionRuntime
        ? "@rolldown/binding-linux-arm64-musl"
        : undefined;
  const pin = viteLibraryBindings.find((pin) => pin.package === platform);
  if (!pin)
    return { available: false as const, reason: "unsupported-native-platform" };
  const directory = path.dirname(
    require.resolve(`${pin.package}/package.json`),
  );
  const bytes = await readFile(
    await withinRoot(root, path.relative(root, path.join(directory, pin.file))),
  );
  if (
    bytes.length !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    return {
      available: false as const,
      reason: "native-binding-byte-mismatch",
    };
  return { available: true as const, directories };
}
