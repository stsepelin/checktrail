import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import { inventorySourcePath } from "./inventory.js";
import { externalPathSchema, externalDigestSchema } from "./external-schema.js";
import { mavenHash } from "./maven.js";
import { terraformRequire } from "./terraform.js";
import {
  terraformExtensionsConfigSchema,
  terraformExtensionsPolicyFile,
  terraformExtensionsRender,
} from "./terraform-extensions-contract.js";
export const terraformExtensionsInvocationSchema = z.strictObject({
  configSha256: externalDigestSchema,
  inputs: z
    .array(
      z.strictObject({
        path: externalPathSchema.max(256),
        sha256: externalDigestSchema,
      }),
    )
    .min(5)
    .max(128),
});
export type TerraformExtensionsInvocation = z.infer<
  typeof terraformExtensionsInvocationSchema
>;
export function terraformExtensionsRegular(
  file: string,
  limit = 4 * 1024 * 1024,
) {
  terraformRequire(
    path.isAbsolute(file) && realpathSync(file) === file,
    "Canonical physical file required",
  );
  const stat = lstatSync(file);
  terraformRequire(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    "Bounded regular file required",
  );
  const bytes = readFileSync(file);
  terraformRequire(
    bytes.length === stat.size && bytes.length <= limit,
    "Physical file changed size",
  );
  return bytes;
}
export function terraformExtensionsCurrent(directory: string) {
  terraformRequire(
    path.isAbsolute(directory) && realpathSync(directory) === directory,
    "Canonical project directory required",
  );
  const files: string[] = [];
  let entries = 0,
    total = 0;
  const walk = (relative: string, depth: number) => {
    terraformRequire(depth <= 32, "Project depth bound");
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      terraformRequire(++entries <= 4096, "Project entry bound");
      const file = relative
        ? path.posix.join(relative, entry.name)
        : entry.name;
      if (
        entry.isSymbolicLink() ||
        !inventorySourcePath(entry.isDirectory() ? file + "/sentinel" : file)
      )
        continue;
      if (entry.isDirectory()) walk(file, depth + 1);
      else {
        const bytes = terraformExtensionsRegular(path.join(directory, file));
        total += bytes.length;
        terraformRequire(
          total <= 32 * 1024 * 1024 && files.length < 128,
          "Project byte/file bound",
        );
        files.push(file);
      }
    }
  };
  walk("", 0);
  files.sort((a, b) => a.localeCompare(b, "en"));
  const policyBytes = terraformExtensionsRegular(
    path.join(directory, terraformExtensionsPolicyFile),
  );
  terraformRequire(
    Buffer.from(policyBytes.toString("utf8")).equals(policyBytes),
    "Policy UTF-8 required",
  );
  const policyText = policyBytes.toString("utf8");
  const documents = parseAllDocuments(policyText, {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  terraformRequire(
    documents.length === 1 &&
      !documents[0]!.errors.length &&
      !documents[0]!.warnings.length,
    "Unique strict policy keys required",
  );
  const config = terraformExtensionsConfigSchema.parse(JSON.parse(policyText));
  const rendered = terraformExtensionsRender(config),
    nativeFiles = Object.keys(rendered);
  terraformRequire(
    isDeepStrictEqual(
      files
        .filter(
          (file) =>
            file.endsWith(".tf") ||
            file.endsWith(".tf.json") ||
            file === ".terraform.lock.hcl",
        )
        .toSorted(),
      nativeFiles.toSorted(),
    ),
    "Declare every root and local Terraform source and the pinned lock",
  );
  terraformRequire(
    !files.some((file) =>
      /\.(?:tfvars(?:\.json)?|tfbackend|tfstate(?:\.backup)?)$/.test(file),
    ),
    "State/backend/variable files require another profile",
  );
  for (const [file, text] of Object.entries(rendered))
    terraformRequire(
      terraformExtensionsRegular(path.join(directory, file)).equals(
        Buffer.from(text),
      ),
      "Native source differs from the finite declaration",
    );
  const invocation = terraformExtensionsInvocationSchema.parse({
    configSha256: mavenHash(policyBytes),
    inputs: files.map((file) => ({
      path: file,
      sha256: mavenHash(terraformExtensionsRegular(path.join(directory, file))),
    })),
  });
  return { config, rendered, files, invocation, directory };
}
export function terraformExtensionsVerify(
  directory: string,
  invocation: TerraformExtensionsInvocation,
) {
  const current = terraformExtensionsCurrent(directory);
  terraformRequire(
    isDeepStrictEqual(current.invocation, invocation),
    "Current physical input/policy cohort differs",
  );
  return current;
}
