import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { readProjectFile, withinRoot } from "./inventory.js";
import { externalPathSchema } from "./external-schema.js";
import type { Check, Inventory, Project } from "./types.js";

export const CHECKSTYLE_VERSION = "14.3.0";
export const CHECKSTYLE_SHA256 =
  "754e218ab1fcabb1e1c5f8530e9d3aa37636806c22987bb279dd907a6ee749b2";
export const checkstyleConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jar: externalPathSchema,
  sha256: z.literal(CHECKSTYLE_SHA256),
  config: externalPathSchema,
  failOn: z.enum(["error", "warning"]),
});
export interface CheckstyleModule {
  name: string;
  properties: { name: string; value: string }[];
  children: CheckstyleModule[];
}
const moduleSchema: z.ZodType<CheckstyleModule> = z.lazy(() =>
  z.strictObject({
    name: z.string().min(1).max(256),
    properties: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(128),
          value: z.string().max(65536),
        }),
      )
      .max(64),
    children: z.array(moduleSchema).max(128),
  }),
);
export const checkstyleInvocationSchema = z.strictObject({
  config: checkstyleConfigSchema,
  configuration: moduleSchema,
  configurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.array(externalPathSchema).min(1).max(20_000),
});
class CheckstylePrerequisiteError extends Error {}
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const rootChecks = new Set([
  "FileTabCharacter",
  "NewlineAtEndOfFile",
  "LineLength",
  "RegexpSingleline",
  "RegexpMultiline",
]);
function shortName(name: string): string {
  const segments = name.split(".");
  const final = segments.at(-1)!;
  return final.endsWith("Check") ? final.slice(0, -5) : final;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CheckstylePrerequisiteError(
      "Expected one Checkstyle XML element",
    );
  return value as Record<string, unknown>;
}
const array = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
export function parseCheckstyleConfiguration(xml: string): CheckstyleModule {
  if (Buffer.byteLength(xml) > 256 * 1024)
    throw new CheckstylePrerequisiteError(
      "Checkstyle configuration exceeds its byte bound",
    );
  if (XMLValidator.validate(xml) !== true)
    throw new CheckstylePrerequisiteError(
      "Malformed Checkstyle XML configuration",
    );
  // Comments are data, not configuration declarations or property expansion.
  const comments = xml.match(/<!--[\s\S]*?-->/g) ?? [];
  if (comments.some((comment) => comment.slice(4, -3).includes("--")))
    throw new CheckstylePrerequisiteError("Malformed Checkstyle XML comment");
  xml = xml.replace(/<!--[\s\S]*?-->/g, "");
  if (/<!\s*ENTITY/i.test(xml) || xml.includes("${"))
    throw new CheckstylePrerequisiteError(
      "Checkstyle configuration cannot contain entities or external property expansion",
    );
  const doctypes = xml.match(/<!DOCTYPE[^>]*>/g) ?? [];
  const allowedDoctypes = [
    '<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">',
    '<!DOCTYPE module PUBLIC "-//Puppy Crawl//DTD Check Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">',
  ];
  if (
    doctypes.length > 1 ||
    doctypes.some(
      (value) => !allowedDoctypes.includes(value.replace(/\s+/g, " ")),
    )
  )
    throw new CheckstylePrerequisiteError(
      "Checkstyle configuration has an unsupported document type",
    );
  const sanitized = doctypes.length ? xml.replace(doctypes[0]!, "") : xml;
  if (
    /<!\s*DOCTYPE/i.test(sanitized) ||
    XMLValidator.validate(sanitized) !== true
  )
    throw new CheckstylePrerequisiteError(
      "Malformed Checkstyle XML configuration",
    );
  for (const entity of sanitized.matchAll(/&([^;]*);/g)) {
    const name = entity[1]!;
    if (["amp", "lt", "gt", "quot", "apos"].includes(name)) continue;
    if (!/^#(?:[0-9]+|x[0-9A-Fa-f]+)$/.test(name))
      throw new CheckstylePrerequisiteError(
        "Only XML character references are supported",
      );
    const code = name.startsWith("#x")
      ? Number.parseInt(name.slice(2), 16)
      : Number(name.slice(1));
    if (!(
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    ))
      throw new CheckstylePrerequisiteError("Invalid XML character reference");
  }
  const document = object(
    new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: false,
      ignoreDeclaration: true,
      processEntities: true,
      htmlEntities: true,
    }).parse(sanitized),
  );
  if (Object.keys(document).length !== 1 || !Object.hasOwn(document, "module"))
    throw new CheckstylePrerequisiteError(
      "Checkstyle requires one Checker root",
    );
  let count = 0;
  const convert = (input: unknown, depth: number): CheckstyleModule => {
    if (++count > 512 || depth > 16)
      throw new CheckstylePrerequisiteError(
        "Checkstyle configuration exceeds its module bound",
      );
    const value = object(input);
    if (
      Object.hasOwn(value, "#text") &&
      (typeof value["#text"] !== "string" || value["#text"].trim())
    )
      throw new CheckstylePrerequisiteError(
        "Unexpected Checkstyle configuration text",
      );
    if (
      Object.keys(value).some(
        (key) => !["@_name", "module", "property", "#text"].includes(key),
      ) ||
      typeof value["@_name"] !== "string"
    )
      throw new CheckstylePrerequisiteError(
        "Unsupported Checkstyle configuration element",
      );
    const name = value["@_name"];
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(name))
      throw new CheckstylePrerequisiteError(
        "Checkstyle module identifiers must be exact",
      );
    const simple = shortName(name);
    if (
      depth === 0
        ? !["Checker", "com.puppycrawl.tools.checkstyle.Checker"].includes(name)
        : depth === 1
          ? !(simple === "TreeWalker" || rootChecks.has(simple))
          : depth !== 2
    )
      throw new CheckstylePrerequisiteError(
        "Unsupported Checkstyle module assembly",
      );
    if (
      name.includes(".") &&
      depth > 0 &&
      name !== "com.puppycrawl.tools.checkstyle.TreeWalker" &&
      !name.startsWith("com.puppycrawl.tools.checkstyle.checks.")
    )
      throw new CheckstylePrerequisiteError(
        "Only pinned built-in Checkstyle modules are supported",
      );
    if (simple === "SuppressWarningsHolder")
      throw new CheckstylePrerequisiteError(
        "Checkstyle suppression holders do not establish active checks",
      );
    const properties = array(value.property).map((input) => {
      const property = object(input);
      if (
        Object.keys(property).length !== 2 ||
        typeof property["@_name"] !== "string" ||
        typeof property["@_value"] !== "string"
      )
        throw new CheckstylePrerequisiteError(
          "Unsupported Checkstyle property",
        );
      const name = property["@_name"],
        value = property["@_value"];
      if (
        !/^[A-Za-z][A-Za-z0-9]*$/.test(name) ||
        Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      )
        throw new CheckstylePrerequisiteError(
          "Invalid Checkstyle property representation",
        );
      if (value.includes("${"))
        throw new CheckstylePrerequisiteError(
          "External property expansion is unsupported",
        );
      if (
        [
          "cacheFile",
          "file",
          "url",
          "headerFile",
          "packageNamesFile",
          "basedir",
        ].includes(name)
      )
        throw new CheckstylePrerequisiteError(
          "Checkstyle cache and external-input properties require another verified profile",
        );
      if (name === "severity" && !["error", "warning", "info"].includes(value))
        throw new CheckstylePrerequisiteError(
          "Ignored Checkstyle severity cannot establish validation",
        );
      if (name === "fileExtensions" && !["java", ".java"].includes(value))
        throw new CheckstylePrerequisiteError(
          "Checkstyle file extensions must retain every selected Java source",
        );
      if (name === "charset" && value !== "UTF-8")
        throw new CheckstylePrerequisiteError(
          "Checkstyle source interpretation requires UTF-8",
        );
      if (name === "skipFileOnJavaParseException" && value !== "false")
        throw new CheckstylePrerequisiteError(
          "Checkstyle cannot skip malformed Java source",
        );
      if (name === "tokens" && !value.trim())
        throw new CheckstylePrerequisiteError(
          "Empty Checkstyle token selection cannot establish activity",
        );
      return { name, value };
    });
    if (
      depth === 1 &&
      rootChecks.has(simple) &&
      !properties.some((property) => property.name === "fileExtensions")
    )
      properties.push({ name: "fileExtensions", value: "java" });
    if (new Set(properties.map((p) => p.name)).size !== properties.length)
      throw new CheckstylePrerequisiteError("Duplicate Checkstyle property");
    const children = array(value.module).map((child) =>
      convert(child, depth + 1),
    );
    if (
      (depth === 1 && simple !== "TreeWalker" && children.length) ||
      (depth === 2 && children.length)
    )
      throw new CheckstylePrerequisiteError(
        "Unsupported nested Checkstyle checks",
      );
    if (depth === 1 && simple === "TreeWalker" && !children.length)
      throw new CheckstylePrerequisiteError(
        "Checkstyle TreeWalker requires active configured checks",
      );
    return {
      name,
      properties: properties.sort((a, b) => a.name.localeCompare(b.name, "en")),
      children,
    };
  };
  const result = moduleSchema.parse(convert(document.module, 0));
  if (!result.children.length)
    throw new CheckstylePrerequisiteError(
      "Checkstyle requires active configured checks",
    );
  return result;
}
export function renderCheckstyleConfiguration(
  configuration: CheckstyleModule,
): string {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const render = (module: CheckstyleModule): string =>
    `<module name="${escape(module.name)}">${module.properties.map((p) => `<property name="${escape(p.name)}" value="${escape(p.value)}"/>`).join("")}${module.children.map(render).join("")}</module>`;
  return (
    '<?xml version="1.0"?><!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN" "https://checkstyle.org/dtds/configuration_1_3.dtd">' +
    render(configuration)
  );
}
export async function checkstyleInputs(
  root: string,
  project: string,
  config: z.infer<typeof checkstyleConfigSchema>,
) {
  const resolve = async (relative: string) => {
    const requested = path.resolve(root, project, relative);
    const file = await withinRoot(root, path.relative(root, requested));
    if (requested !== file)
      throw new CheckstylePrerequisiteError(
        "Checkstyle inputs cannot traverse symbolic links",
      );
    return file;
  };
  const jar = await resolve(config.jar),
    file = await resolve(config.config);
  const info = await stat(jar);
  if (
    !info.isFile() ||
    info.size !== 14731429 ||
    hash(await readFile(jar)) !== config.sha256
  )
    throw new CheckstylePrerequisiteError(
      "Prepare the pinned Checkstyle 14.3.0 all-in-one artifact",
    );
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > 256 * 1024)
    throw new CheckstylePrerequisiteError(
      "Checkstyle configuration exceeds its byte bound",
    );
  const bytes = await readFile(file);
  return {
    jar,
    configuration: parseCheckstyleConfiguration(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ),
    configurationSha256: hash(bytes),
  };
}
export async function checkstyleCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const scope = project.files.filter((file) => file.endsWith(".java"));
  const check: Check = {
    id: "jvm.checkstyle",
    adapter: project.adapter,
    project: project.path,
    scope,
    kind: "analysis",
    parser: "checkstyle-json",
    commands: [],
    reason:
      "Run the explicitly pinned local Checkstyle configuration with native per-file audit events and no cache or suppression filters.",
  };
  try {
    if (!project.files.includes("checktrail.checkstyle.json"))
      throw new CheckstylePrerequisiteError(
        "Prepare an inventoried checktrail.checkstyle.json and local pinned Checkstyle artifact",
      );
    if (!scope.length)
      throw new CheckstylePrerequisiteError(
        "No Java source was inventoried for Checkstyle",
      );
    const config = checkstyleConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.checkstyle.json"),
        ),
      ),
    );
    if (!project.files.includes(config.config))
      throw new CheckstylePrerequisiteError(
        "Checkstyle XML configuration must be inventoried in the selected project",
      );
    const inputs = await checkstyleInputs(source.root, project.path, config);
    const invocation = checkstyleInvocationSchema.parse({
      config,
      configuration: inputs.configuration,
      configurationSha256: inputs.configurationSha256,
      scope,
    });
    const serialized = JSON.stringify(invocation);
    if (Buffer.byteLength(serialized) > 100 * 1024)
      throw new CheckstylePrerequisiteError(
        "Checkstyle invocation exceeds its 100 KiB bound",
      );
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./checkstyle-runner.js", import.meta.url)),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        PATH: process.env.PATH ?? "",
        JAVA_TOOL_OPTIONS: "",
        JDK_JAVA_OPTIONS: "",
        _JAVA_OPTIONS: "",
        CLASSPATH: "",
      },
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof CheckstylePrerequisiteError
        ? error.message
        : "Checkstyle prerequisites are unsupported, unavailable or invalid";
  }
  return check;
}
