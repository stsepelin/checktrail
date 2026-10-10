import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { rubyExtensionsPolicySchema } from "./ruby-extensions-contract.js";
import { readProjectFile } from "./inventory.js";
import { mavenHash, mavenLocal, verifyMavenTree } from "./maven.js";
import type { Check, Inventory, Project } from "./types.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = "[0-9]+(?:\\.[0-9]+){1,3}";
const name = "[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*";
const tests = z.strictObject({
  files: z.array(externalPathSchema).max(256),
  support: z.array(externalPathSchema).max(256),
});
export const rubyToolsConfigV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  rubyVersion: z.literal("4.0.7"),
  bundlerVersion: z.literal("4.0.20"),
  repository: externalPathSchema,
  repositoryManifest: externalPathSchema,
  repositorySha256: digest,
  sources: z.array(externalPathSchema).min(1).max(2048),
  cops: z
    .array(
      z
        .string()
        .regex(
          /^(?:Lint|Layout|Style|Naming|Metrics|Security)\/[A-Za-z][A-Za-z0-9]+$/,
        ),
    )
    .min(1)
    .max(512),
  rspec: tests,
  minitest: tests,
});
export const rubyToolsConfigV2Schema = rubyToolsConfigV1Schema.extend({
  schemaVersion: z.literal(2),
  extensions: rubyExtensionsPolicySchema,
});
export const rubyToolsConfigSchema = z.discriminatedUnion("schemaVersion", [
  rubyToolsConfigV1Schema,
  rubyToolsConfigV2Schema,
]);
/** Declarative lock closure; actual executable manifests are observed only after operator trust. */
export function rubyToolsManifestLock(
  config: z.infer<typeof rubyToolsConfigSchema>,
  gemfile: string,
  lock: string,
) {
  if (config.schemaVersion === 1) return rubyToolsLock(gemfile, lock);
  const policy = config.extensions;
  requireData(
    policy.manifests.includes("Gemfile") &&
      rubyToolsSame(policy.manifests, [...new Set(policy.manifests)]),
    "Declare every evaluated manifest exactly once including Gemfile",
  );
  requireData(
    new Set(policy.dependencies.map((d) => d.name)).size ===
      policy.dependencies.length,
    "Duplicate declared manifest dependency",
  );
  requireData(
    policy.rspecHooks.reduce((n, h) => n + h.registrations, 0) <= 512 &&
      policy.rspecHooks.reduce((n, h) => n + h.invocations, 0) <= 100000 &&
      new Set(
        policy.rspecHooks.map((h) =>
          JSON.stringify([h.kind, h.scope, h.file, h.line]),
        ),
      ).size === policy.rspecHooks.length,
    "Declare unique bounded RSpec hook sources and registration counts",
  );
  for (const d of policy.dependencies) {
    requireData(
      rubyToolsSame(d.groups, [...new Set(d.groups)]) &&
        rubyToolsSame(d.platforms, [...new Set(d.platforms)]),
      "Duplicate manifest group or platform",
    );
  }
  for (const d of policy.dependencies)
    requireData(
      !d.included || d.platformMatches,
      "An excluded platform cannot be included",
    );
  for (const name of ["rubocop", "rspec-core", "minitest"])
    requireData(
      policy.dependencies.some(
        (d) => d.name === name && d.included && d.platformMatches,
      ),
      "Every pinned Ruby checker must be active on the selected platform",
    );
  return rubyToolsLock(
    'source "https://rubygems.org"\nruby "4.0.7"\n' +
      policy.dependencies
        .map((d) => `gem "${d.name}", "${d.version}"\n`)
        .join(""),
    lock,
  );
}
export const rubyToolsRepositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(new RegExp(`^${name}-${version}\\.gem$`)),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: digest,
      }),
    )
    .min(1)
    .max(512),
});
export const rubyToolsInvocationSchema = z.strictObject({
  config: rubyToolsConfigSchema,
  inputs: z
    .array(z.strictObject({ path: externalPathSchema, sha256: digest }))
    .min(1)
    .max(2048),
});
export class RubyToolsPrerequisiteError extends Error {}
const requireData = (value: unknown, message: string): void => {
  if (!value) throw new RubyToolsPrerequisiteError(message);
};
export const rubyToolsSame = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export const rubyToolsSource = (file: string) =>
  /\.(?:rb|rake|gemspec)$/.test(file) ||
  path.posix.basename(file) === "Rakefile";

/** Parse only the bounded public-source lock grammar; never evaluate Ruby DSL. */
export function rubyToolsLock(gemfile: string, lock: string) {
  requireData(
    Buffer.byteLength(gemfile) <= 65536 &&
      Buffer.byteLength(lock) <= 1024 * 1024,
    "Ruby manifest exceeds its bound",
  );
  requireData(
    !/[\r\0]/.test(gemfile + lock) && lock.endsWith("\n"),
    "Ruby manifests require canonical text",
  );
  const declarations = new Map<string, string>();
  let source = 0,
    ruby = 0;
  for (const line of gemfile.split("\n")) {
    if (!line || /^#[^\0]*$/.test(line)) continue;
    if (line === 'source "https://rubygems.org"') {
      source++;
      continue;
    }
    if (line === 'ruby "4.0.7"') {
      ruby++;
      continue;
    }
    const match = new RegExp(`^gem "(${name})",\\s*"(${version})"$`).exec(line);
    requireData(
      match && !declarations.has(match[1]!),
      "Declare exact gems without executable Gemfile expressions",
    );
    declarations.set(match![1]!, match![2]!);
  }
  requireData(
    source === 1 && ruby === 1 && declarations.size > 0,
    "Declare one public Ruby source and the pinned runtime",
  );
  const parts = lock.trimEnd().split("\n\n");
  const expected = [
    "GEM",
    "PLATFORMS",
    "DEPENDENCIES",
    "CHECKSUMS",
    "RUBY VERSION",
    "BUNDLED WITH",
  ];
  requireData(
    parts.length === expected.length &&
      parts.every((part, i) => part.split("\n")[0] === expected[i]),
    "Unsupported or duplicate Ruby lock sections",
  );
  const gemLines = parts[0]!.split("\n");
  requireData(
    gemLines[1] === "  remote: https://rubygems.org/" &&
      gemLines[2] === "  specs:",
    "Ruby lock must use one public source",
  );
  const specs = new Map<string, string>(),
    edges: string[] = [];
  for (const line of gemLines.slice(3)) {
    const spec = new RegExp(`^    (${name}) \\((${version})\\)$`).exec(line);
    if (spec) {
      requireData(!specs.has(spec[1]!), "Duplicate Ruby gem spec");
      specs.set(spec[1]!, spec[2]!);
    } else {
      const dependency = new RegExp(
        `^      (${name})(?: \\((?:(?:~>|>=|<=|=|>|<) ${version})(?:, (?:~>|>=|<=|=|>|<) ${version})*\\))?$`,
      ).exec(line);
      requireData(
        specs.size > 0 && dependency,
        "Unsupported Ruby dependency grammar",
      );
      edges.push(dependency![1]!);
    }
  }
  requireData(
    specs.size > 0 && edges.every((edge) => specs.has(edge)),
    "Ruby dependency closure is incomplete",
  );
  const platforms = parts[1]!
    .split("\n")
    .slice(1)
    .map((line) => {
      requireData(
        /^ {2}(?:ruby|(?:aarch64|x86_64)-linux-(?:musl|gnu)|arm64-darwin-[0-9]+|x86_64-darwin-[0-9]+)$/.test(
          line,
        ),
        "Unsupported Ruby platform",
      );
      return line.slice(2);
    });
  requireData(
    platforms.includes("ruby") && new Set(platforms).size === platforms.length,
    "Ruby source platform is required without duplicates",
  );
  const deps = new Map<string, string>();
  for (const line of parts[2]!.split("\n").slice(1)) {
    const match = new RegExp(`^  (${name}) \\(= (${version})\\)$`).exec(line);
    requireData(
      match && !deps.has(match[1]!) && specs.get(match[1]!) === match[2],
      "Ruby top-level dependency is not exact",
    );
    deps.set(match![1]!, match![2]!);
  }
  requireData(
    rubyToolsSame([...deps.keys()], [...declarations.keys()]) &&
      [...deps].every(([key, value]) => declarations.get(key) === value),
    "Gemfile and locked declarations differ",
  );
  for (const [key, value] of [
    ["rubocop", "1.91.0"],
    ["rspec-core", "3.13.6"],
    ["minitest", "6.0.6"],
  ])
    requireData(
      specs.get(key!) === value,
      "Prepare the pinned Ruby native tools",
    );
  const checksums = new Map<string, string>();
  for (const line of parts[3]!.split("\n").slice(1)) {
    const match = new RegExp(
      `^  (${name}) \\((${version})\\) sha256=([a-f0-9]{64})$`,
    ).exec(line);
    requireData(
      match && !checksums.has(match[1]!) && specs.get(match[1]!) === match[2],
      "Ruby lock checksum is missing or ambiguous",
    );
    checksums.set(match![1]!, match![3]!);
  }
  requireData(
    rubyToolsSame([...specs.keys()], [...checksums.keys()]),
    "Every locked Ruby gem requires its checksum",
  );
  requireData(
    parts[4] === "RUBY VERSION\n  ruby 4.0.7" &&
      parts[5] === "BUNDLED WITH\n  4.0.20",
    "Ruby lock runtime identity differs",
  );
  return {
    platforms,
    files: [...specs].map(([key, value]) => ({
      path: `${key}-${value}.gem`,
      sha256: checksums.get(key)!,
    })),
    specs: Object.fromEntries(specs),
  };
}
export async function rubyToolsRepository(
  root: string,
  project: string,
  config: z.infer<typeof rubyToolsConfigSchema>,
  lock: ReturnType<typeof rubyToolsLock>,
) {
  try {
    const repository = await mavenLocal(root, project, config.repository),
      manifest = await mavenLocal(root, project, config.repositoryManifest);
    requireData(
      repository !== manifest && !manifest.startsWith(repository + path.sep),
      "Ruby manifest must be outside the artifact tree",
    );
    const stat = await lstat(manifest);
    requireData(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024,
      "Ruby repository manifest exceeds its bound",
    );
    const bytes = await readFile(manifest);
    requireData(
      bytes.length <= 1024 * 1024 &&
        mavenHash(bytes) === config.repositorySha256,
      "Ruby repository manifest identity differs",
    );
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes,
    );
    const pins = rubyToolsRepositorySchema.parse(JSON.parse(manifestText));
    requireData(
      rubyToolsSame(
        pins.files.map((f) => f.path),
        lock.files.map((f) => f.path),
      ) &&
        lock.files.every(
          (f) => pins.files.find((p) => p.path === f.path)?.sha256 === f.sha256,
        ),
      "Ruby archives must match every locked checksum exactly",
    );
    await verifyMavenTree(repository, pins.files);
    return { repository, manifestText, pins };
  } catch (error) {
    throw new RubyToolsPrerequisiteError(
      error instanceof RubyToolsPrerequisiteError
        ? error.message
        : "Prepare exact regular Ruby gem archives and a checksum manifest without links",
    );
  }
}
export const rubyToolsProtectedEnvironment = [
  "HOME",
  "RUBYOPT",
  "RUBYLIB",
  "GEM_HOME",
  "GEM_PATH",
  "RUBOCOP_OPTS",
  "SPEC_OPTS",
  "MT_NO_PLUGINS",
  "MT_SEED",
  "BUNDLE_GEMFILE",
  "BUNDLE_PATH",
  "BUNDLE_APP_CONFIG",
  "BUNDLE_USER_HOME",
  "BUNDLE_WITH",
  "BUNDLE_WITHOUT",
  "BUNDLE_BIN",
  "BUNDLE_IGNORE_CONFIG",
  "BUNDLE_FROZEN",
  "BUNDLE_PLUGINS",
  "BUNDLE_DISABLE_CHECKSUM_VALIDATION",
  "BUNDLE_DISABLE_SHARED_GEMS",
  "BUNDLE_DEPLOYMENT",
  "BUNDLE_FORCE_RUBY_PLATFORM",
  "BUNDLE_BUILD__JSON",
  "BUNDLE_BUILD__PRISM",
  "BUNDLE_BUILD__RACC",
  "ENV",
  "BASH_ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
];
export async function rubyToolsCheck(
  source: Inventory,
  project: Project,
  mode: "rubocop" | "rspec" | "minitest",
  extensions = false,
): Promise<Check> {
  const prefix = project.path === "." ? "" : project.path + "/";
  const inputs = source.files
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
  const check: Check = {
    id: `ruby.${mode}${extensions ? "-extensions" : ""}`,
    adapter: "ruby",
    project: project.path,
    scope: [],
    kind: mode === "rubocop" ? "analysis" : "test",
    parser: "ruby-tools-json",
    commands: [],
    reason:
      "Reconcile exact Ruby scope with fresh offline locked gems and native tool participation.",
  };
  try {
    requireData(
      project.files.includes("checktrail.ruby-tools.json"),
      "Declare inventoried checktrail.ruby-tools.json with complete source, test and gem scope",
    );
    const config = rubyToolsConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.ruby-tools.json"),
        ),
      ),
    );
    requireData(
      config.schemaVersion === (extensions ? 2 : 1),
      "Select the exact Ruby manifest profile and matching check IDs",
    );
    if (config.schemaVersion === 2) {
      requireData(
        config.extensions.rspecHooks.every((h) =>
          [...config.rspec.files, ...config.rspec.support].includes(h.file),
        ),
        "Declared RSpec hooks must belong to selected source",
      );
      for (const file of config.extensions.manifests) {
        const value = await readProjectFile(
          source.root,
          path.posix.join(project.path, file),
        );
        requireData(
          Buffer.byteLength(value) <= 65536 && !/[\r\0]/.test(value),
          "Evaluated manifests require bounded canonical text",
        );
      }
    }
    if (config.schemaVersion === 2)
      requireData(
        config.extensions.manifests.every(
          (f) =>
            inputs.includes(f) &&
            (f === "Gemfile" || config.sources.includes(f)),
        ),
        "Every evaluated manifest must belong to current declared inputs",
      );
    requireData(
      rubyToolsSame(config.sources, inputs.filter(rubyToolsSource)),
      "Declare every inventoried Ruby source exactly once",
    );
    requireData(
      new Set(config.cops).size === config.cops.length,
      "Duplicate Ruby cops",
    );
    requireData(
      inputs.includes("Gemfile") && inputs.includes("Gemfile.lock"),
      "Ruby native checks require inventoried Gemfile and lock",
    );
    const selected = [...config.rspec.files, ...config.minitest.files];
    requireData(
      new Set(selected).size === selected.length,
      "Duplicate Ruby test targets",
    );
    for (const suite of [config.rspec, config.minitest]) {
      requireData(
        new Set([...suite.files, ...suite.support]).size ===
          suite.files.length + suite.support.length &&
          [...suite.files, ...suite.support].every(
            (f) => config.sources.includes(f) && f.endsWith(".rb"),
          ),
        "Ruby tests and support must belong to declared source scope",
      );
      requireData(
        suite.files.length > 0 || suite.support.length === 0,
        "Ruby test support has no target",
      );
    }
    check.scope =
      mode === "rubocop"
        ? ["Gemfile", ...config.sources]
        : [...config[mode].files, ...config[mode].support];
    requireData(
      check.scope.length > 0,
      "No Ruby tests declared for this framework",
    );
    const lock = rubyToolsManifestLock(
      config,
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "Gemfile"),
      ),
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "Gemfile.lock"),
      ),
    );
    await rubyToolsRepository(source.root, project.path, config, lock);
    requireData(
      inputs.length <= 2048,
      "Ruby input inventory exceeds its bound",
    );
    const pins = [];
    for (const file of inputs) {
      const bytes = await readFile(
        await mavenLocal(source.root, project.path, file),
      );
      requireData(
        bytes.length <= 4 * 1024 * 1024,
        "Ruby input exceeds its bound",
      );
      pins.push({ path: file, sha256: mavenHash(bytes) });
    }
    const invocation = rubyToolsInvocationSchema.parse({
        config,
        inputs: pins,
      }),
      serialized = JSON.stringify(invocation);
    requireData(
      Buffer.byteLength(serialized) <= 200 * 1024,
      "Ruby invocation exceeds its bound",
    );
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./ruby-tools-runner.js", import.meta.url)),
        source.root,
        serialized,
        mode,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: Object.fromEntries(
        rubyToolsProtectedEnvironment.map((key) => [key, ""]),
      ),
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof RubyToolsPrerequisiteError
        ? error.message
        : "Ruby native prerequisites are invalid or unsupported";
  }
  return check;
}
