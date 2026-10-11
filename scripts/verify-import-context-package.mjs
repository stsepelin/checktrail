import { selectJavaScriptToolsLock } from "./prepare-javascript-tools.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { installAcceptancePackage } from "./install-acceptance-package.mjs";
const profile =
  process.env.CHECKTRAIL_IMPORT_CONTEXT_PROFILE ?? "import-context";
assert.ok(
  [
    "import-context",
    "import-history",
    "selected-syntax-context",
    "review-context-limits",
    "host-session-readiness",
    "context-python",
    "context-go",
    "context-php",
    "context-rust",
    "context-java",
    "context-kotlin",
    "context-scala",
    "context-csharp",
    "context-fsharp",
    "context-ruby",
    "context-swift",
    "context-vb",
    "context-c",
    "context-cpp",
    "context-hcl",
    "context-yaml",
    "assembly-vue-router",
    "assembly-fastapi",
    "assembly-django",
    "assembly-nuxt",
    "assembly-laravel",
    "javascript-extensions",
    "python-extensions",
    "php-extensions",
    "rust-extensions",
    "jvm-wrappers",
    "kotlin-extensions",
    "scala-extensions",
    "jvm-analyzer-extensions",
    "kubernetes-extensions",
    "kustomize-extensions",
    "confidence-provenance",
    "dotnet-fsharp-format",
    "dotnet-format-extensions",
    "dotnet-generator-extensions",
    "ruby-extensions",
    "swift-extensions",
    "cpp-extensions",
  ].includes(profile),
);
if (profile === "review-context-limits")
  process.env.CHECKTRAIL_CONTEXT_LIMITS_INSTALLED = "1";
if (profile === "host-session-readiness")
  process.env.CHECKTRAIL_HOST_SESSION_INSTALLED = "1";
if (profile === "context-python")
  process.env.CHECKTRAIL_CONTEXT_PYTHON_INSTALLED = "1";
if (profile === "context-go") process.env.CHECKTRAIL_CONTEXT_GO_INSTALLED = "1";
if (profile === "context-php")
  process.env.CHECKTRAIL_CONTEXT_PHP_INSTALLED = "1";
if (profile === "context-rust")
  process.env.CHECKTRAIL_CONTEXT_RUST_INSTALLED = "1";
if (profile === "context-java")
  process.env.CHECKTRAIL_CONTEXT_JAVA_INSTALLED = "1";
if (profile === "context-kotlin")
  process.env.CHECKTRAIL_CONTEXT_KOTLIN_INSTALLED = "1";
if (profile === "context-scala")
  process.env.CHECKTRAIL_CONTEXT_SCALA_INSTALLED = "1";
if (profile === "context-csharp")
  process.env.CHECKTRAIL_CONTEXT_CSHARP_INSTALLED = "1";
if (profile === "context-fsharp")
  process.env.CHECKTRAIL_CONTEXT_FSHARP_INSTALLED = "1";
if (profile === "context-ruby")
  process.env.CHECKTRAIL_CONTEXT_RUBY_INSTALLED = "1";
if (profile === "context-swift")
  process.env.CHECKTRAIL_CONTEXT_SWIFT_INSTALLED = "1";
if (profile === "context-vb") process.env.CHECKTRAIL_CONTEXT_VB_INSTALLED = "1";
if (profile === "context-c") process.env.CHECKTRAIL_CONTEXT_C_INSTALLED = "1";
if (profile === "context-cpp")
  process.env.CHECKTRAIL_CONTEXT_CPP_INSTALLED = "1";
if (profile === "context-hcl") {
  process.env.CHECKTRAIL_CONTEXT_HCL_INSTALLED = "1";
  process.env.CHECKTRAIL_CONTEXT_HCL_NATIVE = "1";
}
if (profile === "context-yaml") {
  process.env.CHECKTRAIL_CONTEXT_YAML_INSTALLED = "1";
  process.env.CHECKTRAIL_CONTEXT_YAML_NATIVE = "1";
}
if (profile === "assembly-nuxt")
  process.env.CHECKTRAIL_NUXT_ASSEMBLY_INSTALLED = "1";
if (profile === "assembly-django")
  process.env.CHECKTRAIL_DJANGO_ASSEMBLY_INSTALLED = "1";
if (profile === "rust-extensions")
  process.env.CHECKTRAIL_RUST_EXTENSIONS_INSTALLED = "1";
if (profile === "php-extensions")
  process.env.CHECKTRAIL_PHP_EXTENSIONS_INSTALLED = "1";
if (profile === "python-extensions")
  process.env.CHECKTRAIL_PYTHON_EXTENSIONS_INSTALLED = "1";
if (profile === "javascript-extensions")
  process.env.CHECKTRAIL_JAVASCRIPT_EXTENSIONS_INSTALLED = "1";
if (profile === "assembly-laravel")
  process.env.CHECKTRAIL_LARAVEL_ASSEMBLY_INSTALLED = "1";
if (profile === "assembly-fastapi")
  process.env.CHECKTRAIL_FASTAPI_ASSEMBLY_INSTALLED = "1";
if (profile === "assembly-vue-router")
  process.env.CHECKTRAIL_ROUTER_ASSEMBLY_INSTALLED = "1";
if (profile === "jvm-wrappers")
  process.env.CHECKTRAIL_JVM_WRAPPERS_INSTALLED = "1";
if (profile === "kotlin-extensions")
  process.env.CHECKTRAIL_KOTLIN_EXTENSIONS_INSTALLED = "1";
if (profile === "scala-extensions")
  process.env.CHECKTRAIL_SCALA_EXTENSIONS_INSTALLED = "1";
if (profile === "jvm-analyzer-extensions")
  process.env.CHECKTRAIL_JVM_ANALYZER_EXTENSIONS_INSTALLED = "1";
if (profile === "kubernetes-extensions")
  process.env.CHECKTRAIL_KUBERNETES_EXTENSIONS_INSTALLED = "1";
if (profile === "kustomize-extensions")
  process.env.CHECKTRAIL_KUSTOMIZE_EXTENSIONS_INSTALLED = "1";
if (profile === "dotnet-fsharp-format")
  process.env.CHECKTRAIL_FSHARP_FORMAT_INSTALLED = "1";
if (profile === "dotnet-format-extensions")
  process.env.CHECKTRAIL_DOTNET_FORMAT_EXTENSIONS_INSTALLED = "1";
if (profile === "dotnet-generator-extensions")
  process.env.CHECKTRAIL_DOTNET_GENERATOR_EXTENSIONS_INSTALLED = "1";
if (profile === "cpp-extensions")
  process.env.CHECKTRAIL_CPP_EXTENSIONS_INSTALLED = "1";
if (profile === "swift-extensions")
  process.env.CHECKTRAIL_SWIFT_EXTENSIONS_INSTALLED = "1";
if (profile === "ruby-extensions")
  process.env.CHECKTRAIL_RUBY_EXTENSIONS_INSTALLED = "1";
if (profile === "confidence-provenance")
  process.env.CHECKTRAIL_CONFIDENCE_PROVENANCE_INSTALLED = "1";
const rubyAcceptanceShard =
  process.env.CHECKTRAIL_RUBY_EXTENSIONS_ACCEPTANCE_SHARD;
if (rubyAcceptanceShard !== undefined) {
  assert.equal(profile, "ruby-extensions");
  assert.ok(["all", "1", "2", "3"].includes(rubyAcceptanceShard));
  assert.equal(
    process.env.CHECKTRAIL_IMPORT_CONTEXT_IMAGE,
    undefined,
    "Ruby shard acceptance runs inside the prepared offline container",
  );
}
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(
  path.join(tmpdir(), "checktrail-import-context-package-"),
);
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const tarball = path.join(temporary, packed.filename),
    consumer = path.join(temporary, "consumer");
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await installAcceptancePackage(repository, tarball, consumer);
  const installed = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src",
  );
  await mkdir(path.join(consumer, "dist/test"), { recursive: true });
  await symlink(
    path.relative(path.join(consumer, "dist"), installed),
    path.join(consumer, "dist/src"),
  );
  for (const file of [
    "import-context.test.js",
    "review-polyglot.test.js",
    "review-context-limits.test.js",
    "review-polyglot-fixture.js",
    "import-history.test.js",
    "git-fixture.js",
    "helpers.js",
    "review-call-identity-fixture.js",
    "gate-context-python.test.js",
    "gate-context-go.test.js",
    "gate-context-php.test.js",
    "gate-context-rust.test.js",
    "gate-context-java.test.js",
    "gate-context-kotlin.test.js",
    "gate-context-scala.test.js",
    "gate-context-csharp.test.js",
    "gate-context-fsharp.test.js",
    "gate-context-ruby.test.js",
    "gate-context-swift.test.js",
    "gate-context-vb.test.js",
    "gate-context-c.test.js",
    "gate-context-cpp.test.js",
    "gate-context-hcl.test.js",
    "gate-context-yaml.test.js",
    "gate-assembly-nuxt.test.js",
    "review-nuxt-assembly-fixture.js",
    "gate-javascript-extensions.test.js",
    "gate-rust-extensions.test.js",
    "gate-kotlin-extensions.test.js",
    "kotlin-extensions-fixture.js",
    "gate-jvm-analyzer-extensions.test.js",
    "gate-kubernetes-extensions.test.js",
    "kubernetes-extensions-fixture.js",
    "kubeconform-fixture.js",
    "gate-kustomize-extensions.test.js",
    "kustomize-extensions-fixture.js",
    "kustomize-fixture.js",
    "gate-dotnet-fsharp-format.test.js",
    "gate-dotnet-format-extensions.test.js",
    "dotnet-format-extensions-fixture.js",
    "gate-dotnet-generator-extensions.test.js",
    "gate-ruby-extensions.test.js",
    "gate-swift-extensions.test.js",
    "gate-cpp-extensions.test.js",
    "cpp-extensions-fixture.js",
    "cpp-extensions-surfaces.test.js",
    "cpp-extensions-cancel.test.js",
    "swift-extensions-fixture.js",
    "ruby-extensions-fixture.js",
    "ruby-tools-fixture.js",
    "dotnet-generator-extensions-fixture.js",
    "dotnet-build-fixture.js",
    "dotnet-generated-fixture.js",
    "dotnet-format-fixture.js",
    "dotnet-test-controls.js",
    "fsharp-format-fixture.js",
    "gate-confidence-provenance.test.js",
    "confidence-provenance-fixture.js",
    "native-process-observer.js",
    "spotbugs-extensions-fixture.js",
    "spotbugs-fixture.js",
    "detekt-extensions-fixture.js",
    "detekt-fixture.js",
    "gate-scala-extensions.test.js",
    "scala-extensions-fixture.js",
    "scala-extension-evidence-fixture.js",
    "scala-fixture.js",
    "kotlin-fixture.js",
    "gate-jvm-wrappers.test.js",
    "jvm-wrappers-fixture.js",
    "maven-fixture.js",
    "gradle-fixture.js",
    "rust-extensions-fixture.js",
    "rust-workspace-fixture.js",
    "gate-php-extensions.test.js",
    "php-extensions-fixture.js",
    "gate-python-extensions.test.js",
    "python-extensions-fixture.js",
    "javascript-extensions-fixture.js",
    "tool-fixture.js",
    "gate-assembly-laravel.test.js",
    "review-laravel-assembly-fixture.js",
    "review-laravel-assembly-contract.js",
    "gate-assembly-django.test.js",
    "review-django-assembly-fixture.js",
    "gate-assembly-fastapi.test.js",
    "review-fastapi-assembly-fixture.js",
    "gate-assembly-vue-router.test.js",
    "review-vue-router-assembly-fixture.js",
    "review-yaml-boundaries-fixture.js",
    "review-hcl-boundaries-fixture.js",
    "review-name-boundaries-fixture.js",
    "review-cpp-boundaries-fixture.js",
    "review-c-boundaries-fixture.js",
    "review-vb-boundaries-fixture.js",
    "review-swift-boundaries-fixture.js",
    "review-ruby-boundaries-fixture.js",
    "review-fsharp-boundaries-fixture.js",
    "review-csharp-boundaries-fixture.js",
    "review-scala-boundaries-fixture.js",
    "review-kotlin-boundaries-fixture.js",
    "review-java-boundaries-fixture.js",
    "gate-host-session-readiness.test.js",
    "review-host-process-fixture.js",
    "review-workflow-fixture.js",
  ])
    await cp(
      path.join(repository, "dist/test", file),
      path.join(consumer, "dist/test", file),
    );
  if (profile === "ruby-extensions") {
    await mkdir(path.join(consumer, "examples"), { recursive: true });
    await cp(
      path.join(repository, "examples/ruby-tools"),
      path.join(consumer, "examples/ruby-tools"),
      { recursive: true },
    );
  }
  if (profile === "dotnet-generator-extensions") {
    await mkdir(path.join(consumer, "examples"));
    await cp(
      path.join(repository, "examples/dotnet-build"),
      path.join(consumer, "examples/dotnet-build"),
      { recursive: true },
    );
    await mkdir(path.join(consumer, "scripts"), { recursive: true });
    await cp(
      path.join(repository, "scripts/dotnet-build-fixture-projects.json"),
      path.join(consumer, "scripts/dotnet-build-fixture-projects.json"),
    );
  }
  if (profile === "dotnet-fsharp-format") {
    const prepared = path.join(consumer, ".checktrail/fsharp-format-tools");
    await mkdir(path.dirname(prepared), { recursive: true });
    await cp(
      process.env.CHECKTRAIL_FSHARP_FORMAT_CACHE ??
        path.join(repository, ".checktrail/fsharp-format-tools"),
      prepared,
      { recursive: true },
    );
    process.env.CHECKTRAIL_FSHARP_FORMAT_CACHE = prepared;
  }
  if (profile === "assembly-nuxt") {
    const prepared = path.join(consumer, ".checktrail/nuxt-tools/node_modules");
    await mkdir(path.dirname(prepared), { recursive: true });
    await cp(
      path.join(
        repository,
        ".checktrail",
        process.platform === "darwin" ? "nuxt-linux-tools" : "nuxt-tools",
        "node_modules",
      ),
      prepared,
      { recursive: true },
    );
  }
  if (profile === "jvm-wrappers") {
    const source =
      process.env.CHECKTRAIL_JVM_WRAPPERS_CACHE ??
      path.join(repository, ".checktrail");
    await mkdir(path.join(consumer, ".checktrail"), { recursive: true });
    for (const name of [
      "maven-review-tools",
      "maven-dependencies",
      "gradle-review-tools",
      "gradle-dependencies",
      "jvm-wrapper-tools",
    ])
      await cp(
        path.join(source, name),
        path.join(consumer, ".checktrail", name),
        { recursive: true },
      );
    process.env.CHECKTRAIL_JVM_WRAPPERS_CACHE = path.join(
      consumer,
      ".checktrail",
    );
  }
  if (profile === "php-extensions") {
    const prepared = path.join(consumer, ".checktrail/php-review-tools/vendor");
    await mkdir(path.dirname(prepared), { recursive: true });
    await cp(
      path.join(repository, ".checktrail/php-review-tools/vendor"),
      prepared,
      { recursive: true },
    );
  }
  if (profile === "assembly-laravel") {
    const prepared = path.join(consumer, ".checktrail/laravel-tools/vendor");
    await mkdir(path.dirname(prepared), { recursive: true });
    await cp(
      path.join(repository, ".checktrail/laravel-tools/vendor"),
      prepared,
      { recursive: true },
    );
  }
  if (profile === "assembly-vue-router") {
    const prepared = path.join(
      consumer,
      ".checktrail/vue-router-tools/node_modules",
    );
    await mkdir(path.dirname(prepared), { recursive: true });
    await cp(
      path.join(repository, ".checktrail/vue-router-tools/node_modules"),
      prepared,
      { recursive: true },
    );
  }
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  const dependencies = {};
  const dependencySource =
    profile === "javascript-extensions"
      ? await access(
          path.join(repository, ".checktrail/javascript-tools/node_modules"),
        ).then(
          () =>
            path.join(repository, ".checktrail/javascript-tools/node_modules"),
          () => path.join(repository, "node_modules"),
        )
      : path.join(repository, "node_modules");
  async function copyClientDependency(name, optional = false) {
    if (Object.hasOwn(dependencies, name)) return;
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(
          path.join(dependencySource, name, "package.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (optional && error.code === "ENOENT") return;
      throw error;
    }
    const entry = lock.packages["node_modules/" + name];
    assert.equal(manifest.version, entry.version);
    const destination = path.join(consumer, "node_modules", name);
    const existing = await readFile(
      path.join(destination, "package.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
    if (existing) {
      assert.equal(existing.version, manifest.version);
      return;
    }
    dependencies[name] = manifest.version;
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(dependencySource, name), destination, {
      recursive: true,
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyClientDependency(
        dependency,
        Object.hasOwn(manifest.optionalDependencies ?? {}, dependency),
      );
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      await copyClientDependency(dependency, true);
  }
  if (profile === "javascript-extensions") {
    const selected = selectJavaScriptToolsLock(
      JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")),
      lock,
    ).lock;
    const copies = [];
    for (const [key, entry] of Object.entries(selected.packages)) {
      if (!key) continue;
      assert.ok(
        key.startsWith("node_modules/") &&
          !key.split("/").includes("..") &&
          !key.includes("\\"),
      );
      const source = path.join(
        dependencySource,
        key.slice("node_modules/".length),
      );
      let metadata;
      try {
        metadata = JSON.parse(
          await readFile(path.join(source, "package.json"), "utf8"),
        );
      } catch (error) {
        if (entry.optional && error.code === "ENOENT") continue;
        throw error;
      }
      assert.equal(metadata.version, entry.version);
      const target = path.join(consumer, key);
      const existing = await readFile(path.join(target, "package.json"), "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
      if (existing) {
        assert.equal(existing.version, metadata.version);
        continue;
      }
      copies.push({ key, source, target, version: metadata.version });
    }
    // Validate every selected native/JS dependency before copying any harness tool.
    for (const copy of copies) {
      await mkdir(path.dirname(copy.target), { recursive: true });
      await cp(copy.source, copy.target, { recursive: true });
      dependencies[copy.key] = copy.version;
    }
  } else await copyClientDependency("@modelcontextprotocol/client");
  await mkdir(path.join(consumer, "scripts"), { recursive: true });
  for (const file of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
    ...(rubyAcceptanceShard === undefined
      ? []
      : [
          "verify-ruby-extensions-acceptance.mjs",
          "ruby-extensions-acceptance-selection.mjs",
        ]),
  ])
    await cp(
      path.join(repository, "scripts", file),
      path.join(consumer, "scripts", file),
    );
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(consumer, "scripts/required-native-tests.json"),
    JSON.stringify({
      [profile]: profiles[profile],
    }),
  );
  const selectedImage = process.env.CHECKTRAIL_IMPORT_CONTEXT_IMAGE;
  const image = selectedImage
    ? execFileSync(
        "docker",
        ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
        { encoding: "utf8" },
      ).trim()
    : undefined;
  if (image) assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const output = image
    ? execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--network",
          "none",
          ...(profile === "assembly-fastapi"
            ? ["--env", "CHECKTRAIL_FASTAPI_ASSEMBLY_INSTALLED=1"]
            : []),
          ...(profile === "assembly-nuxt"
            ? ["--env", "CHECKTRAIL_NUXT_ASSEMBLY_INSTALLED=1"]
            : []),
          ...(profile === "javascript-extensions"
            ? ["--env", "CHECKTRAIL_JAVASCRIPT_EXTENSIONS_INSTALLED=1"]
            : []),
          ...(profile === "rust-extensions"
            ? ["--env", "CHECKTRAIL_RUST_EXTENSIONS_INSTALLED=1"]
            : []),
          ...(profile === "kotlin-extensions"
            ? ["--env", "CHECKTRAIL_KOTLIN_EXTENSIONS_INSTALLED=1"]
            : []),
          ...(profile === "scala-extensions"
            ? ["--env", "CHECKTRAIL_SCALA_EXTENSIONS_INSTALLED=1"]
            : []),
          ...(profile === "jvm-wrappers"
            ? [
                "--env",
                "CHECKTRAIL_JVM_WRAPPERS_INSTALLED=1",
                "--env",
                "CHECKTRAIL_JVM_WRAPPERS_CACHE=/consumer/.checktrail",
              ]
            : []),
          ...(profile === "php-extensions"
            ? ["--env", "CHECKTRAIL_PHP_EXTENSIONS_INSTALLED=1"]
            : []),
          ...(profile === "python-extensions"
            ? ["--env", "CHECKTRAIL_PYTHON_EXTENSIONS_INSTALLED=1"]
            : []),
          ...(profile === "assembly-laravel"
            ? ["--env", "CHECKTRAIL_LARAVEL_ASSEMBLY_INSTALLED=1"]
            : []),
          ...(profile === "assembly-django"
            ? ["--env", "CHECKTRAIL_DJANGO_ASSEMBLY_INSTALLED=1"]
            : []),
          ...(profile === "assembly-vue-router"
            ? ["--env", "CHECKTRAIL_ROUTER_ASSEMBLY_INSTALLED=1"]
            : []),
          ...(profile === "review-context-limits"
            ? ["--env", "CHECKTRAIL_CONTEXT_LIMITS_INSTALLED=1"]
            : []),
          ...(profile === "host-session-readiness"
            ? ["--env", "CHECKTRAIL_HOST_SESSION_INSTALLED=1"]
            : []),
          ...(profile === "context-python"
            ? ["--env", "CHECKTRAIL_CONTEXT_PYTHON_INSTALLED=1"]
            : []),
          ...(profile === "context-go"
            ? ["--env", "CHECKTRAIL_CONTEXT_GO_INSTALLED=1"]
            : []),
          ...(profile === "context-php"
            ? ["--env", "CHECKTRAIL_CONTEXT_PHP_INSTALLED=1"]
            : []),
          ...(profile === "context-rust"
            ? ["--env", "CHECKTRAIL_CONTEXT_RUST_INSTALLED=1"]
            : []),
          ...(profile === "context-java"
            ? ["--env", "CHECKTRAIL_CONTEXT_JAVA_INSTALLED=1"]
            : []),
          ...(profile === "context-kotlin"
            ? ["--env", "CHECKTRAIL_CONTEXT_KOTLIN_INSTALLED=1"]
            : []),
          ...(profile === "context-scala"
            ? ["--env", "CHECKTRAIL_CONTEXT_SCALA_INSTALLED=1"]
            : []),
          ...(profile === "context-csharp"
            ? ["--env", "CHECKTRAIL_CONTEXT_CSHARP_INSTALLED=1"]
            : []),
          ...(profile === "context-fsharp"
            ? ["--env", "CHECKTRAIL_CONTEXT_FSHARP_INSTALLED=1"]
            : []),
          ...(profile === "context-ruby"
            ? ["--env", "CHECKTRAIL_CONTEXT_RUBY_INSTALLED=1"]
            : []),
          ...(profile === "context-swift"
            ? ["--env", "CHECKTRAIL_CONTEXT_SWIFT_INSTALLED=1"]
            : []),
          ...(profile === "context-c"
            ? ["--env", "CHECKTRAIL_CONTEXT_C_INSTALLED=1"]
            : []),
          ...(profile === "context-cpp"
            ? ["--env", "CHECKTRAIL_CONTEXT_CPP_INSTALLED=1"]
            : []),
          ...(profile === "context-yaml"
            ? [
                "--env",
                "CHECKTRAIL_CONTEXT_YAML_INSTALLED=1",
                "--env",
                "CHECKTRAIL_CONTEXT_YAML_NATIVE=1",
              ]
            : []),
          ...(profile === "context-hcl"
            ? [
                "--env",
                "CHECKTRAIL_CONTEXT_HCL_INSTALLED=1",
                "--env",
                "CHECKTRAIL_CONTEXT_HCL_NATIVE=1",
              ]
            : []),
          ...(profile === "context-vb"
            ? [
                "--env",
                "CHECKTRAIL_CONTEXT_VB_INSTALLED=1",
                "--env",
                "DOTNET_CLI_HOME=/tmp",
                "--env",
                "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1",
              ]
            : []),
          "--read-only",
          "--cpus",
          "2",
          "--memory",
          profile === "jvm-wrappers" ? "4g" : "2g",
          "--pids-limit",
          "256",
          "--tmpfs",
          profile === "jvm-wrappers"
            ? "/tmp:rw,nosuid,nodev,exec,size=2048m"
            : profile === "php-extensions"
              ? "/tmp:rw,nosuid,nodev,noexec,size=1024m"
              : [
                    "assembly-nuxt",
                    "javascript-extensions",
                    "python-extensions",
                    "rust-extensions",
                    "kotlin-extensions",
                    "scala-extensions",
                  ].includes(profile)
                ? "/tmp:rw,exec,nosuid,nodev,size=1024m"
                : [
                      "context-go",
                      "context-rust",
                      "context-swift",
                      "context-c",
                      "context-cpp",
                    ].includes(profile)
                  ? "/tmp:rw,exec,nosuid,nodev,size=256m"
                  : [
                        "context-scala",
                        "context-csharp",
                        "context-ruby",
                        "context-vb",
                        "context-hcl",
                        "context-yaml",
                        "assembly-vue-router",
                        "assembly-fastapi",
                        "assembly-django",
                        "assembly-laravel",
                        "javascript-extensions",
                      ].includes(profile)
                    ? "/tmp:rw,nosuid,nodev,noexec,size=256m"
                    : "/tmp:rw,nosuid,nodev,size=256m",
          ...(process.env.CHECKTRAIL_TEST_TASK
            ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
            : []),
          "--mount",
          `type=bind,src=${consumer},target=/consumer,readonly`,
          "--workdir",
          "/consumer",
          image,
          "node",
          "scripts/verify-required-native-tests.mjs",
          profile,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      )
    : execFileSync(
        process.execPath,
        rubyAcceptanceShard === undefined
          ? ["scripts/verify-required-native-tests.mjs", profile]
          : [
              "scripts/verify-ruby-extensions-acceptance.mjs",
              "installed",
              rubyAcceptanceShard,
            ],
        { cwd: consumer, encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
  const acceptance = JSON.parse(output);
  assert.equal(acceptance.complete, true);
  process.stdout.write(
    JSON.stringify({
      tarballSha256,
      offlineProductionInstall: true,
      lifecycleScriptsExecuted: false,
      installedCliEvaluated: profile !== "host-session-readiness",
      installedRuntimeEvaluated: true,
      harnessOutsideInstalledPackage: true,
      acceptanceClientDependencies: dependencies,
      profile: acceptance,
      environment: image
        ? {
            image,
            network: "none",
            consumerMount: "readonly",
            rootFilesystemReadonly: true,
            temporaryFilesystemMiB:
              profile === "jvm-wrappers"
                ? 2048
                : profile === "php-extensions"
                  ? 1024
                  : [
                        "assembly-nuxt",
                        "javascript-extensions",
                        "python-extensions",
                        "rust-extensions",
                        "kotlin-extensions",
                        "scala-extensions",
                      ].includes(profile)
                    ? 1024
                    : 256,
            temporaryFilesystemExecutable: [
              "jvm-wrappers",
              "kotlin-extensions",
              "scala-extensions",
              "context-go",
              "context-rust",
              "context-swift",
              "context-c",
              "context-cpp",
              "assembly-nuxt",
              "javascript-extensions",
              "python-extensions",
              "rust-extensions",
            ].includes(profile),
          }
        : {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      qualityGate: "not-assessed",
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
