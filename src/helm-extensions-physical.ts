import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import { inventorySourcePath } from "./inventory.js";
import { externalPathSchema, externalDigestSchema } from "./external-schema.js";
import { mavenHash } from "./maven.js";
import { helmRequire } from "./helm.js";
import {
  helmExtensionsConfigSchema,
  helmExtensionsPolicyFile,
  helmExtensionsRender,
} from "./helm-extensions-contract.js";
export const helmExtensionsInvocationSchema = z.strictObject({
  configSha256: externalDigestSchema,
  inputs: z
    .array(
      z.strictObject({
        path: externalPathSchema.max(256),
        sha256: externalDigestSchema,
      }),
    )
    .min(13)
    .max(128),
});
export type HelmExtensionsInvocation = z.infer<
  typeof helmExtensionsInvocationSchema
>;
export function helmExtensionsJson(text: string): unknown {
  const docs = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  helmRequire(
    docs.length === 1 && !docs[0]!.errors.length && !docs[0]!.warnings.length,
    "One strict unique-key JSON document required",
  );
  return JSON.parse(text) as unknown;
}
export function helmExtensionsRegular(file: string, limit = 256 * 1024) {
  helmRequire(
    path.isAbsolute(file) && realpathSync(file) === file,
    "Canonical physical file required",
  );
  const st = lstatSync(file);
  helmRequire(
    st.isFile() && !st.isSymbolicLink() && st.size <= limit,
    "Bounded regular file required",
  );
  const bytes = readFileSync(file);
  helmRequire(
    bytes.length === st.size && bytes.length <= limit,
    "Physical file size changed",
  );
  return bytes;
}
export function helmExtensionsCurrent(directory: string) {
  helmRequire(
    path.isAbsolute(directory) && realpathSync(directory) === directory,
    "Canonical project root required",
  );
  const files: string[] = [];
  let entries = 0,
    total = 0;
  const walk = (relative: string, depth: number) => {
    helmRequire(depth <= 32, "Chart depth bound");
    for (const e of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      helmRequire(++entries <= 4096, "Chart entry bound");
      const f = path.posix.join(relative, e.name);
      if (!inventorySourcePath(e.isDirectory() ? f + "/sentinel" : f)) continue;
      helmRequire(!e.isSymbolicLink(), "Physical chart aliases unsupported");
      if (e.isDirectory()) walk(f, depth + 1);
      else {
        const bytes = helmExtensionsRegular(path.join(directory, f));
        total += bytes.length;
        helmRequire(
          files.length < 128 && total <= 8 * 1024 * 1024,
          "Chart file/byte bound",
        );
        files.push(f);
      }
    }
  };
  walk("", 0);
  files.sort((a, b) => a.localeCompare(b, "en"));
  const bytes = helmExtensionsRegular(
    path.join(directory, helmExtensionsPolicyFile),
  );
  helmRequire(
    Buffer.from(bytes.toString("utf8")).equals(bytes),
    "UTF-8 policy required",
  );
  const config = helmExtensionsConfigSchema.parse(
      helmExtensionsJson(bytes.toString("utf8")),
    ),
    rendered = helmExtensionsRender(config),
    native = Object.keys(rendered).toSorted();
  helmRequire(
    isDeepStrictEqual(
      files
        .filter(
          (f) =>
            f !== helmExtensionsPolicyFile &&
            f !== "checktrail.json" &&
            (/\.(?:yaml|yml|json|tpl|tgz)$/.test(f) ||
              ["Chart.lock", ".helmignore"].includes(path.posix.basename(f))),
        )
        .toSorted(),
      native,
    ),
    "Declare the entire physical chart closure; locks archives hooks CRDs helpers and ignores require another profile",
  );
  for (const [f, text] of Object.entries(rendered))
    helmRequire(
      helmExtensionsRegular(path.join(directory, f)).equals(Buffer.from(text)),
      "Native chart differs from its declared bytes",
    );
  const invocation = helmExtensionsInvocationSchema.parse({
    configSha256: mavenHash(bytes),
    inputs: files.map((f) => ({
      path: f,
      sha256: mavenHash(helmExtensionsRegular(path.join(directory, f))),
    })),
  });
  return { directory, config, rendered, files, invocation };
}
export function helmExtensionsVerify(
  directory: string,
  invocation: HelmExtensionsInvocation,
) {
  const c = helmExtensionsCurrent(directory);
  helmRequire(
    isDeepStrictEqual(c.invocation, invocation),
    "Current physical chart/policy cohort differs",
  );
  return c;
}
