import path from "node:path";
import { z } from "zod";
import { importJUnit } from "./junit.js";
import {
  mavenHash,
  mavenInvocationSchema,
  mavenRepositorySchema,
} from "./maven.js";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";
const eventSchema = z
  .object({
    type: z.enum([
      "init",
      "close",
      "ProjectDiscoveryStarted",
      "SessionStarted",
      "SessionEnded",
      "ProjectStarted",
      "ProjectSucceeded",
      "ProjectFailed",
      "ProjectSkipped",
      "MojoStarted",
      "MojoSucceeded",
      "MojoFailed",
      "MojoSkipped",
      "ForkStarted",
      "ForkSucceeded",
      "ForkFailed",
      "ForkedProjectStarted",
      "ForkedProjectSucceeded",
      "ForkedProjectFailed",
      "beforeMojo",
      "afterMojo",
      "failedMojo",
    ]),
    module: z.string().nullable().optional(),
  })
  .catchall(z.unknown());
const nodeSchema = z.strictObject({
  type: z.enum(["discovered", "dynamic", "started", "skipped", "finished"]),
  module: z.string(),
  id: z.string().min(1),
  parent: z.string().nullable(),
  test: z.boolean(),
  className: z.string().nullable(),
  output: z.string().nullable(),
  sourceFile: z.string().nullable(),
  reason: z.string().optional(),
  status: z.enum(["SUCCESSFUL", "FAILED", "ABORTED"]).optional(),
  failure: z.string().nullable().optional(),
});
const schema = z.strictObject({
  version: z.literal(2),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.literal("25.0.4+7-LTS"),
  maven: z.literal("3.10.0"),
  launcherPid: z.number().int().min(1),
  distribution: z.string().min(1).max(8192),
  repositoryManifest: z
    .string()
    .min(1)
    .max(1024 * 1024),
  workspace: z.string(),
  artifacts: z.array(z.string()).min(1).max(4096),
  exitCode: z.number().int().min(0).max(255),
  events: z.array(eventSchema).min(1).max(20000),
  tests: z
    .array(
      z.union([
        nodeSchema,
        z.strictObject({
          type: z.enum(["planStarted", "planFinished"]),
          module: z.string(),
          launcher: z.string().optional(),
          engine: z.string().optional(),
        }),
      ]),
    )
    .max(20000),
  modules: z
    .array(
      z.strictObject({
        path: z.string(),
        inputs: z.strictObject({
          compile: z.array(z.string()),
          testCompile: z.array(z.string()),
        }),
        reports: z
          .array(z.strictObject({ file: z.string(), xml: z.string() }))
          .max(256),
      }),
    )
    .max(64),
  console: z.strictObject({
    stdoutBytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024),
    stderrBytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024),
    stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/),
    stderrSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
function assertEvidence(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const empty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && !value.length) ||
  (typeof value === "object" && value !== null && !Object.keys(value).length);
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const plugins = {
  resources: "org.apache.maven.plugins:maven-resources-plugin:3.5.0",
  compiler: "org.apache.maven.plugins:maven-compiler-plugin:3.16.0",
  surefire: "org.apache.maven.plugins:maven-surefire-plugin:3.6.0",
};
export function mavenEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "tests" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Maven evidence does not reconcile fresh reactor, compiler and native test participation",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({ unavailable: z.literal("maven-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "The pinned Temurin JVM is unavailable",
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason: "Maven native evidence collection did not complete",
      findingsComplete: false,
    };
  let confirmed: TestEvidence | undefined;
  try {
    const data = schema.parse(JSON.parse(process.stdout)),
      invocation = mavenInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      );
    assertEvidence(
      data.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Input receipt identity",
    );
    assertEvidence(
      path.isAbsolute(data.workspace) &&
        path.basename(data.workspace) === "workspace",
      "Fresh workspace identity",
    );
    assertEvidence(
      same(
        check.scope,
        invocation.inputs
          .filter((item) => item.path.endsWith(".java"))
          .map((item) => item.path),
      ),
      "Planned source scope",
    );
    assertEvidence(
      data.distribution ===
        path.resolve(
          check.commands[0]!.args[1]!,
          check.project,
          invocation.config.distribution,
        ),
      "Configured native Maven distribution",
    );
    const events = data.events,
      ofType = (type: string) => events.filter((event) => event.type === type);
    assertEvidence(
      events[0]!.type === "init" &&
        events.at(-1)!.type === "close" &&
        ofType("init").length === 1 &&
        ofType("close").length === 1,
      "Collector lifecycle",
    );
    assertEvidence(
      events[0]!.processId === data.launcherPid &&
        events[0]!.home === data.distribution,
      "Owned native Maven client and distribution",
    );
    assertEvidence(
      ofType("SessionStarted").length === 1 &&
        ofType("SessionEnded").length === 1,
      "Native session lifecycle",
    );
    const reactor = z
      .array(z.strictObject({ path: z.string(), packaging: z.string() }))
      .parse(ofType("SessionStarted")[0]!.reactor);
    const declared = invocation.config.modules;
    assertEvidence(
      reactor.length === declared.length &&
        new Set(reactor.map((item) => item.path)).size === reactor.length,
      "Reactor identities",
    );
    for (const module of declared)
      assertEvidence(
        reactor.some(
          (item) =>
            item.path === path.resolve(data.workspace, module.path) &&
            item.packaging === module.packaging,
        ),
        "Declared native module",
      );
    const ended = z
      .array(z.string())
      .parse(ofType("SessionEnded")[0]!.exceptions);
    assertEvidence(
      data.modules.length === declared.length &&
        new Set(data.modules.map((item) => item.path)).size === declared.length,
      "Collected module identities",
    );
    const repository = path.join(path.dirname(data.workspace), "repository");
    assertEvidence(
      Buffer.byteLength(data.repositoryManifest) <= 1024 * 1024 &&
        mavenHash(data.repositoryManifest) ===
          invocation.config.repositorySha256,
      "Pinned Maven repository manifest receipt",
    );
    const artifactPins = mavenRepositorySchema.parse(
      JSON.parse(data.repositoryManifest),
    );
    assertEvidence(
      new Set(artifactPins.files.map((item) => item.path)).size ===
        artifactPins.files.length &&
        same(
          data.artifacts,
          artifactPins.files
            .filter((item) => item.path.endsWith(".jar"))
            .map((item) => path.join(repository, item.path)),
        ),
      "Exact Maven native artifact closure",
    );
    assertEvidence(
      new Set(data.artifacts).size === data.artifacts.length &&
        data.artifacts.every(
          (file) =>
            path.resolve(file) === file &&
            file.startsWith(repository + path.sep) &&
            file.endsWith(".jar"),
        ),
      "Pinned dependency identities",
    );
    const allowedClassPath = new Set([
      ...data.artifacts,
      ...declared.flatMap((module) => [
        path.resolve(data.workspace, module.path, "target/classes"),
        path.resolve(data.workspace, module.path, "target/test-classes"),
      ]),
    ]);
    const nativeFailed = events.filter((event) => event.type === "MojoFailed");
    const compilerFailure = nativeFailed.some(
      (event) =>
        event.plugin === plugins.compiler &&
        Array.isArray(event.causes) &&
        event.causes.includes(
          "org.apache.maven.plugin.compiler.CompilationFailureException",
        ),
    );
    if (data.exitCode !== 0 && compilerFailure)
      return {
        status: "failed",
        reason:
          "The native Maven compiler reported a compilation failure; complete analysis and test execution are not established",
        findingsComplete: false,
      };
    const totals: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
    for (const module of declared) {
      const base = path.resolve(data.workspace, module.path),
        moduleEvents = events.filter((event) => event.module === base);
      assertEvidence(
        moduleEvents.filter((event) => event.type === "ProjectStarted")
          .length === 1,
        "Module started once",
      );
      assertEvidence(
        !moduleEvents.some(
          (event) =>
            event.type === "ProjectSkipped" || event.type.startsWith("Fork"),
        ),
        "Module not skipped or forked",
      );
      const captured = data.modules.find((item) => item.path === module.path)!;
      assertEvidence(captured, "Module collection missing");
      const before = moduleEvents.filter(
          (event) => event.type === "beforeMojo",
        ),
        after = moduleEvents.filter((event) =>
          ["afterMojo", "MojoFailed"].includes(event.type),
        );
      if (module.packaging === "pom") {
        assertEvidence(
          before.length === 0 &&
            captured.reports.length === 0 &&
            captured.inputs.compile.length === 0 &&
            captured.inputs.testCompile.length === 0,
          "Aggregator role",
        );
        continue;
      }
      const expected = [
        `${plugins.resources}/resources/default-resources`,
        `${plugins.compiler}/compile/default-compile`,
        `${plugins.resources}/testResources/default-testResources`,
        `${plugins.compiler}/testCompile/default-testCompile`,
        `${plugins.surefire}/test/default-test`,
      ];
      const key = (event: z.infer<typeof eventSchema>) =>
        `${event.plugin}/${event.goal}/${event.execution}`;
      assertEvidence(
        same(before.map(key), expected) && same(after.map(key), expected),
        "Fixed lifecycle execution set",
      );
      for (const event of before) {
        assertEvidence(!event.collectionError, "Native parameter collection");
        const fields = z.record(z.string(), z.unknown()).parse(event.fields);
        if (
          event.plugin === plugins.compiler ||
          event.plugin === plugins.surefire
        )
          assertEvidence(
            z
              .array(z.string())
              .parse(event.classPath)
              .every((file) => allowedClassPath.has(file)),
            "Pinned native classpath",
          );
        if (event.plugin === plugins.compiler) {
          const test = event.goal === "testCompile",
            source = path.join(base, test ? "src/test/java" : "src/main/java");
          assertEvidence(
            same(
              z
                .array(z.string())
                .parse(fields.compileSourceRoots)
                .filter(
                  (root) =>
                    !root.endsWith(
                      test
                        ? "/target/generated-test-sources/test-annotations"
                        : "/target/generated-sources/annotations",
                    ),
                ),
              [source],
            ),
            "Native Java source roots",
          );
          assertEvidence(
            fields.outputDirectory ===
              path.join(
                base,
                test ? "target/test-classes" : "target/classes",
              ) &&
              fields.encoding === "UTF-8" &&
              fields.compilerId === "javac" &&
              empty(fields.executable) &&
              empty(fields.compilerArgs) &&
              empty(fields.compilerArgument) &&
              empty(fields.compilerArguments) &&
              fields.fork === false &&
              fields.failOnError === true &&
              fields[test ? "skip" : "skipMain"] === false &&
              empty(fields[test ? "testIncludes" : "includes"]) &&
              empty(fields[test ? "testExcludes" : "excludes"]) &&
              fields.proc !== "only",
            "Native compiler participation",
          );
          const expectedInputs = check.scope
            .filter((file) =>
              file.startsWith(
                path.posix.join(
                  module.path,
                  test ? "src/test/java" : "src/main/java",
                ) + "/",
              ),
            )
            .map((file) => path.resolve(data.workspace, file));
          assertEvidence(
            same(
              captured.inputs[test ? "testCompile" : "compile"],
              expectedInputs,
            ),
            "Fresh compiler input accounting",
          );
        }
        if (event.plugin === plugins.surefire) {
          for (const name of [
            "skip",
            "skipExec",
            "skipTests",
            "testFailureIgnore",
            "disableXmlReport",
          ])
            assertEvidence(
              Object.hasOwn(fields, name) &&
                (fields[name] === false || fields[name] === null),
              "Native test skip/failure policy",
            );
          for (const name of [
            "test",
            "includes",
            "excludes",
            "groups",
            "excludedGroups",
            "includeJUnit5Engines",
            "excludeJUnit5Engines",
            "properties",
            "systemPropertiesFile",
            "suiteXmlFiles",
            "dependenciesToScan",
            "additionalClasspathDependencies",
            "classpathDependencyExcludes",
            "argLine",
            "jvm",
          ])
            assertEvidence(
              empty(fields[name]),
              "Unfiltered native test profile",
            );
          assertEvidence(
            same(
              z.array(z.string()).parse(fields.additionalClasspathElements),
              [path.join(path.dirname(data.workspace), "observer.jar")],
            ),
            "Owned test observer classpath",
          );
          assertEvidence(
            fields.rerunFailingTestsCount === 0 &&
              fields.skipAfterFailureCount === 0 &&
              fields.forkCount === "1" &&
              fields.reuseForks === true,
            "Single native test attempt",
          );
          assertEvidence(
            fields.reportsDirectory ===
              path.join(base, "target/surefire-reports") &&
              fields.testClassesDirectory ===
                path.join(base, "target/test-classes") &&
              fields.classesDirectory === path.join(base, "target/classes") &&
              (fields.workingDirectory === base ||
                fields.workingDirectory === null),
            "Fresh output locations",
          );
        }
      }
      const declarationEvent = after.find(
        (event) =>
          event.plugin === plugins.compiler && event.goal === "testCompile",
      );
      assertEvidence(
        declarationEvent && !declarationEvent.collectionError,
        "Native test source declarations",
      );
      const declarations = z
        .array(z.strictObject({ className: z.string(), file: z.string() }))
        .parse(declarationEvent.declarations);
      assertEvidence(
        new Set(declarations.map((item) => item.className)).size ===
          declarations.length,
        "Unique native source declarations",
      );
      for (const item of module.testClasses)
        assertEvidence(
          declarations.some(
            (declaration) =>
              declaration.className === item.className &&
              declaration.file === path.resolve(base, item.file),
          ),
          "Declared test source binding",
        );
      const testEvents = data.tests.filter((event) => event.module === base);
      assertEvidence(
        testEvents.filter((event) => event.type === "planStarted").length ===
          1 &&
          testEvents.filter((event) => event.type === "planFinished").length ===
            1 &&
          testEvents[0]?.type === "planStarted" &&
          testEvents.at(-1)?.type === "planFinished",
        "JUnit plan completion",
      );
      const startedPlan = testEvents[0]!;
      assertEvidence(
        "launcher" in startedPlan &&
          startedPlan.launcher ===
            path.join(
              repository,
              "org/junit/platform/junit-platform-launcher/6.1.3/junit-platform-launcher-6.1.3.jar",
            ) &&
          "engine" in startedPlan &&
          startedPlan.engine ===
            path.join(
              repository,
              "org/junit/jupiter/junit-jupiter-engine/6.1.3/junit-jupiter-engine-6.1.3.jar",
            ),
        "Pinned native JUnit runtime",
      );
      const nodes = testEvents.filter(
          (event): event is z.infer<typeof nodeSchema> => "id" in event,
        ),
        discovered = nodes.filter((event) =>
          ["discovered", "dynamic"].includes(event.type),
        );
      assertEvidence(
        new Set(discovered.map((event) => event.id)).size === discovered.length,
        "Distinct discovered tests",
      );
      const byId = new Map(discovered.map((event) => [event.id, event]));
      const classes = new Set(module.testClasses.map((item) => item.className));
      for (const node of nodes) {
        const original = byId.get(node.id);
        assertEvidence(
          original &&
            node.id.startsWith("[engine:junit-jupiter]") &&
            JSON.stringify([
              node.parent,
              node.test,
              node.className,
              node.output,
              node.sourceFile,
            ]) ===
              JSON.stringify([
                original.parent,
                original.test,
                original.className,
                original.output,
                original.sourceFile,
              ]),
          "Native node identity",
        );
        if (node.parent !== null)
          assertEvidence(byId.has(node.parent), "Native parent identity");
        if (node.className !== null)
          assertEvidence(
            classes.has(node.className) &&
              node.output === path.join(base, "target/test-classes") &&
              node.sourceFile ===
                path.posix.basename(
                  module.testClasses.find(
                    (item) => item.className === node.className,
                  )!.file,
                ),
            "Declared test class origin",
          );
      }
      for (const name of classes)
        assertEvidence(
          discovered.some((node) => node.className === name),
          "Every declared test class discovered",
        );
      const counts: TestEvidence = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
      };
      for (const node of discovered) {
        const terminal = nodes.filter(
            (event) =>
              event.id === node.id &&
              ["skipped", "finished"].includes(event.type),
          ),
          started = nodes.filter(
            (event) => event.id === node.id && event.type === "started",
          );
        let ancestor = node.parent,
          ancestorSkipped = false;
        const ancestors = new Set<string>();
        while (ancestor !== null) {
          assertEvidence(!ancestors.has(ancestor), "Acyclic test hierarchy");
          ancestors.add(ancestor);
          if (
            nodes.some(
              (event) => event.id === ancestor && event.type === "skipped",
            )
          )
            ancestorSkipped = true;
          ancestor = byId.get(ancestor)?.parent ?? null;
        }
        assertEvidence(
          terminal.length === 1 || (!terminal.length && ancestorSkipped),
          "Every node terminal",
        );
        if (terminal[0]?.type === "finished")
          assertEvidence(
            started.length === 1 && terminal[0].status !== undefined,
            "Started terminal test",
          );
        else assertEvidence(started.length === 0, "Skipped node not started");
        if (!node.test) {
          assertEvidence(
            terminal[0]?.status !== "FAILED" &&
              terminal[0]?.status !== "ABORTED",
            "Container infrastructure failure",
          );
          continue;
        }
        counts.total++;
        if (
          ancestorSkipped ||
          terminal[0]?.type === "skipped" ||
          terminal[0]?.status === "ABORTED"
        )
          counts.skipped++;
        else if (terminal[0]?.status === "FAILED") counts.failed++;
        else {
          assertEvidence(
            terminal[0]?.status === "SUCCESSFUL",
            "Successful terminal test",
          );
          counts.passed++;
        }
      }
      const xml: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
      assertEvidence(
        captured.reports.length > 0 &&
          new Set(captured.reports.map((item) => item.file)).size ===
            captured.reports.length,
        "Fresh reports",
      );
      for (const report of captured.reports) {
        assertEvidence(
          /^TEST-[A-Za-z0-9_.$-]+\.xml$/.test(report.file),
          "Report identity",
        );
        const imported = importJUnit(report.xml);
        assertEvidence(
          imported.tests && imported.cases && imported.tests.total > 0,
          "Reconciled XML report",
        );
        for (const key of ["total", "passed", "failed", "skipped"] as const)
          xml[key] += imported.tests[key];
      }
      assertEvidence(
        JSON.stringify(xml) === JSON.stringify(counts),
        "Native/XML counts agree",
      );
      for (const key of ["total", "passed", "failed", "skipped"] as const)
        totals[key] += counts[key];
      if (
        counts.failed &&
        data.exitCode !== 0 &&
        nativeFailed.some(
          (event) => event.module === base && event.plugin === plugins.surefire,
        )
      )
        confirmed = { ...totals };
      assertEvidence(counts.total > 0, "Discovered tests in every module");
      assertEvidence(
        moduleEvents.filter(
          (event) =>
            event.type ===
            (counts.failed ? "ProjectFailed" : "ProjectSucceeded"),
        ).length === 1,
        "Native module result",
      );
    }
    assertEvidence(
      data.tests.every((event) =>
        declared.some(
          (module) =>
            module.packaging === "jar" &&
            path.resolve(data.workspace, module.path) === event.module,
        ),
      ),
      "No foreign test module",
    );
    if (totals.failed) {
      assertEvidence(
        data.exitCode !== 0 &&
          nativeFailed.length > 0 &&
          nativeFailed.every((event) => event.plugin === plugins.surefire) &&
          ended.length > 0,
        "Native failure agrees with tests",
      );
      return {
        status: "failed",
        reason:
          "Native Maven test failures reconcile with fresh Surefire reports",
        tests: totals,
        findingsComplete: true,
      };
    }
    assertEvidence(
      data.exitCode === 0 && nativeFailed.length === 0 && ended.length === 0,
      "Successful native session",
    );
    if (totals.skipped)
      return {
        ...incomplete,
        reason:
          "Maven executed tests, but skipped or aborted cases leave validation incomplete",
        tests: totals,
      };
    assertEvidence(totals.passed > 0, "Executed native tests");
    return {
      status: "passed",
      reason:
        "Every declared Maven module compiled from fresh inputs and executed reconciled native JUnit tests",
      tests: totals,
      findingsComplete: true,
    };
  } catch {
    return confirmed
      ? {
          status: "failed",
          reason:
            "Reconciled native Maven test failures were found; remaining reactor participation is incomplete",
          tests: confirmed,
          findingsComplete: false,
        }
      : incomplete;
  }
}
