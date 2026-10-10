import { jvmExtensionPacketSchema } from "./jvm-workspace-extensions.js";
import { reconcileJvmExtensions } from "./jvm-extension-evidence.js";
import path from "node:path";
import { externalPathSchema } from "./external-schema.js";
import { z } from "zod";
import { gradleInvocationSchema, gradleModulePath } from "./gradle.js";
import { mavenHash, mavenRepositorySchema } from "./maven.js";
import {
  nativeDeclarationSchema,
  nativeJUnitEventSchema,
  nativeReportSchema,
  nativeTotals,
  reconcileNativeJUnit,
  requireNative,
} from "./junit-native.js";
import { XMLParser } from "fast-xml-parser";
import { nativeJUnitCases } from "./junit-native.js";
import { importJUnit } from "./junit.js";
import type {
  Check,
  CheckResult,
  ProcessResult,
  TestEvidence,
} from "./types.js";
const string = z.string().min(1).max(8192),
  strings = z.array(string).max(4096),
  count = z.number().int().min(0).max(20000);
const common = {
  path: string,
  project: string,
  className: string,
  actions: strings,
  enabled: z.boolean(),
  onlyIf: string,
};
const taskSchema = z.discriminatedUnion("role", [
  z.strictObject({
    ...common,
    role: z.literal("compile"),
    source: strings,
    classpath: strings,
    destination: string,
    release: z.number().int().min(8).max(25).nullable(),
    encoding: z.string().nullable(),
    fork: z.boolean(),
    compilerArgs: strings,
    annotationProcessors: strings,
    java: string,
    javaLanguage: z.number().int(),
  }),
  z.strictObject({
    ...common,
    role: z.literal("resources"),
    source: strings,
    destination: string,
  }),
  z.strictObject({ ...common, role: z.literal("lifecycle") }),
  z.strictObject({ ...common, role: z.literal("jar"), output: string }),
  z.strictObject({
    ...common,
    role: z.literal("test"),
    classpath: strings,
    testClasses: strings,
    workingDirectory: string,
    includes: strings,
    excludes: strings,
    includePatterns: strings,
    excludePatterns: strings,
    scanForTestClasses: z.boolean(),
    ignoreFailures: z.boolean(),
    failFast: z.boolean(),
    failOnNoMatchingTests: z.boolean(),
    maxParallelForks: z.number().int(),
    forkEvery: z.number().int(),
    optionsClass: string,
    includeTags: strings,
    excludeTags: strings,
    includeEngines: strings,
    excludeEngines: strings,
    systemProperties: z.record(z.string(), z.unknown()),
    jvmArgs: strings,
    java: string,
    javaLanguage: z.number().int(),
    xml: string,
    xmlRequired: z.boolean(),
    mergeReruns: z.boolean(),
  }),
]);
const descriptor = {
  task: string,
  id: string,
  parent: string.nullable(),
  className: string.nullable(),
  name: string,
  displayName: string,
};
const terminal = {
  status: z.enum(["SUCCESS", "FAILURE", "SKIPPED"]),
  tests: count,
  passed: count,
  failed: count,
  skipped: count,
};
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("init"),
    processId: z.number().int().min(1),
    wrapperAncestors: z
      .array(z.number().int().min(1))
      .min(1)
      .max(16)
      .optional(),
    version: z.literal("9.8.0"),
    runtime: z.literal("25.0.4+7-LTS"),
    home: string,
    userHome: string,
    offline: z.boolean(),
    tasks: strings,
    excludedTasks: strings,
    parallel: z.boolean(),
    maxWorkers: z.number().int(),
  }),
  z.strictObject({
    type: z.literal("projects"),
    projects: z
      .array(
        z.strictObject({
          path: string,
          directory: string,
          build: string,
          tests: strings,
          sourceSets: z
            .array(
              z.strictObject({
                name: string,
                java: strings,
                javaRoots: strings,
                resources: strings,
              }),
            )
            .nullable(),
        }),
      )
      .max(64),
  }),
  z.strictObject({
    type: z.literal("graph"),
    tasks: z.array(taskSchema).max(512),
  }),
  z.strictObject({ type: z.literal("taskStarted"), task: taskSchema }),
  z.strictObject({
    type: z.literal("taskFinished"),
    task: string,
    snapshot: taskSchema,
    skipped: z.boolean(),
    skipMessage: z.string().nullable(),
    noSource: z.boolean(),
    upToDate: z.boolean(),
    didWork: z.boolean(),
    failures: strings,
  }),
  z.strictObject({ type: z.literal("suiteStarted"), ...descriptor }),
  z.strictObject({ type: z.literal("testStarted"), ...descriptor }),
  z.strictObject({
    type: z.literal("testFinished"),
    ...descriptor,
    ...terminal,
    failures: strings,
  }),
  z.strictObject({
    type: z.literal("suiteFinished"),
    ...descriptor,
    ...terminal,
  }),
  z.strictObject({ type: z.literal("close"), failures: strings }),
]);
export const gradlePacketSchema = z.strictObject({
  version: z.literal(1),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.literal("25.0.4+7-LTS"),
  gradle: z.literal("9.8.0"),
  launcherPid: z.number().int().min(1),
  workspace: string,
  distribution: string,
  extensions: jvmExtensionPacketSchema.optional(),
  repositoryManifest: z.string().max(1024 * 1024),
  artifacts: z.array(externalPathSchema).min(1).max(4096),
  exitCode: z.number().int().min(0).max(255),
  events: z.array(eventSchema).min(1).max(20000),
  tests: z.array(nativeJUnitEventSchema).max(20000),
  modules: z
    .array(
      z.strictObject({
        path: string,
        reports: z.array(nativeReportSchema).max(256),
        declarations: z.array(nativeDeclarationSchema).max(2048),
      }),
    )
    .max(64),
  console: z.strictObject({
    stdoutBytes: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024),
    stderrBytes: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024),
    stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/),
    stderrSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const identical = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Outcome = Pick<
  CheckResult,
  "status" | "reason" | "tests" | "findingsComplete"
>;
export function gradleEvidence(
  check: Check,
  processes: ProcessResult[],
): Outcome {
  const incomplete: Outcome = {
    status: "inconclusive",
    reason:
      "Gradle evidence does not reconcile fresh projects, compiler inputs, native task participation and test terminals",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({ unavailable: z.literal("gradle-toolchain") }).parse(
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
      reason: "Gradle native evidence collection did not complete",
      findingsComplete: false,
    };
  let confirmed: TestEvidence | undefined;
  try {
    const data = gradlePacketSchema.parse(JSON.parse(process.stdout)),
      invocation = gradleInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      temporary = path.dirname(data.workspace),
      repository = path.join(temporary, "repository"),
      observer = path.join(temporary, "observer.jar");
    requireNative(
      data.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Current input receipt",
    );
    requireNative(
      mavenHash(data.repositoryManifest) === invocation.config.repositorySha256,
      "Pinned dependency manifest receipt",
    );
    const artifactPins = mavenRepositorySchema.parse(
      JSON.parse(data.repositoryManifest),
    );
    requireNative(
      same(
        data.artifacts,
        artifactPins.files.map((file) => file.path),
      ),
      "Exact pinned native artifact closure",
    );
    requireNative(
      invocation.config.extensions ||
        data.distribution ===
          path.resolve(
            check.commands[0]!.args[1]!,
            check.project,
            invocation.config.distribution,
          ),
      "Configured native distribution binding",
    );
    requireNative(
      path.isAbsolute(data.workspace) &&
        path.basename(data.workspace) === "workspace",
      "Fresh workspace",
    );
    const generatedOutputs = reconcileJvmExtensions(
      "gradle",
      invocation.config.extensions,
      data.extensions,
      check.commands[0]!.args[1]!,
      check.project,
      invocation.inputs,
      data.workspace,
      data.distribution,
    );
    const ofType = <T extends z.infer<typeof eventSchema>["type"]>(type: T) =>
      data.events.filter(
        (event): event is Extract<z.infer<typeof eventSchema>, { type: T }> =>
          event.type === type,
      );
    const starts = ofType("init"),
      closes = ofType("close"),
      projects = ofType("projects"),
      graphs = ofType("graph");
    requireNative(
      starts.length === 1 &&
        closes.length === 1 &&
        projects.length === 1 &&
        graphs.length === 1 &&
        data.events[0]!.type === "init" &&
        data.events.at(-1)!.type === "close",
      "Complete native build lifecycle",
    );
    requireNative(
      invocation.config.extensions
        ? starts[0]!.wrapperAncestors?.[0] === starts[0]!.processId &&
            starts[0]!.wrapperAncestors.includes(data.launcherPid) &&
            new Set(starts[0]!.wrapperAncestors).size ===
              starts[0]!.wrapperAncestors.length
        : starts[0]!.processId === data.launcherPid &&
            starts[0]!.wrapperAncestors === undefined,
      "Native build runs beneath the owned launcher",
    );
    requireNative(
      starts[0]!.home === data.distribution &&
        starts[0]!.userHome === path.join(temporary, "home") &&
        starts[0]!.offline &&
        same(starts[0]!.tasks, ["test"]) &&
        !starts[0]!.excludedTasks.length &&
        !starts[0]!.parallel &&
        starts[0]!.maxWorkers === 1,
      "Protected native execution policy",
    );
    requireNative(
      data.modules.length === invocation.config.modules.length &&
        same(
          data.modules.map((m) => m.path),
          invocation.config.modules.map((m) =>
            path.resolve(data.workspace, m.path),
          ),
        ),
      "Declared captured module accounting",
    );
    const metadata = projects[0]!.projects,
      tasks = graphs[0]!.tasks;
    requireNative(
      same(
        metadata.map((m) => m.path),
        invocation.config.modules.map((m) => gradleModulePath(m.path)),
      ) && new Set(tasks.map((t) => t.path)).size === tasks.length,
      "Exact native modules and graph",
    );
    requireNative(
      data.tests.every((event) =>
        invocation.config.modules.some(
          (module) =>
            module.kind === "java" &&
            event.module === path.resolve(data.workspace, module.path),
        ),
      ),
      "No foreign test module",
    );
    const allowed = new Set(
      data.artifacts
        .filter((file) => file.endsWith(".jar"))
        .map((file) => path.join(repository, file)),
    );
    allowed.add(observer);
    for (const module of invocation.config.modules) {
      const base = path.resolve(data.workspace, module.path);
      for (const output of [
        "build/classes/java/main",
        "build/classes/java/test",
        "build/resources/main",
        "build/resources/test",
      ])
        allowed.add(path.join(base, output));
    }
    for (const task of tasks)
      if (task.role === "jar") {
        requireNative(
          path.dirname(task.output) === path.join(task.project, "build/libs") &&
            path.basename(task.output).endsWith(".jar"),
          "Fresh native jar output",
        );
        allowed.add(task.output);
      }
    for (const module of invocation.config.modules) {
      const id = gradleModulePath(module.path),
        base = path.resolve(data.workspace, module.path),
        meta = metadata.find((m) => m.path === id)!;
      requireNative(
        meta.directory === base &&
          ["build.gradle", "build.gradle.kts"].some(
            (name) =>
              meta.build === path.join(base, name) &&
              invocation.inputs.some(
                (input) => input.path === path.posix.join(module.path, name),
              ),
          ),
        "Native module directory and build binding",
      );
      const taskPath = (name: string) =>
        id === ":" ? ":" + name : id + ":" + name;
      if (module.kind === "aggregator") {
        requireNative(
          !meta.tests.length &&
            (!meta.sourceSets || !meta.sourceSets.length) &&
            !tasks.some((task) => task.project === base),
          "Empty native aggregator",
        );
        continue;
      }
      requireNative(
        same(meta.tests, [taskPath("test")]) &&
          meta.sourceSets &&
          same(
            meta.sourceSets.map((s) => s.name),
            ["main", "test"],
          ),
        "Every native test task and source set",
      );
      for (const set of meta.sourceSets!) {
        const expected = invocation.inputs
          .filter(
            (input) =>
              input.path.startsWith(
                path.posix.join(module.path, "src", set.name, "java") + "/",
              ) && input.path.endsWith(".java"),
          )
          .map((input) => path.join(data.workspace, input.path));
        if (set.name === "main")
          expected.push(
            ...generatedOutputs
              .filter((output) =>
                output.path.startsWith(
                  path.posix.join(module.path, "src/main/java") + "/",
                ),
              )
              .map((output) => path.join(data.workspace, output.path)),
          );
        const resources = invocation.inputs
          .filter((input) =>
            input.path.startsWith(
              path.posix.join(module.path, "src", set.name, "resources") + "/",
            ),
          )
          .map((input) => path.join(data.workspace, input.path));
        requireNative(
          same(set.java, expected) &&
            same(set.javaRoots, [path.join(base, "src", set.name, "java")]) &&
            same(set.resources, resources),
          "Complete selected native source set",
        );
      }
      const expectedNames = [
          "compileJava",
          "processResources",
          "classes",
          "compileTestJava",
          "processTestResources",
          "testClasses",
          "test",
        ],
        memberTasks = tasks.filter((t) => t.project === base);
      requireNative(
        same(
          memberTasks.filter((t) => t.role !== "jar").map((t) => t.path),
          expectedNames.map(taskPath),
        ) && memberTasks.filter((t) => t.role === "jar").length <= 1,
        "Every declared native task",
      );
      for (const task of memberTasks) {
        const name = task.path.slice(task.path.lastIndexOf(":") + 1);
        requireNative(
          task.path === taskPath(name) &&
            task.enabled &&
            task.onlyIf ===
              "org.gradle.api.internal.tasks.execution.DescribingAndSpec",
          "Exact active native task",
        );
        const className =
          task.role === "compile"
            ? "org.gradle.api.tasks.compile.JavaCompile_Decorated"
            : task.role === "resources"
              ? "org.gradle.language.jvm.tasks.ProcessResources_Decorated"
              : task.role === "test"
                ? "org.gradle.api.tasks.testing.Test_Decorated"
                : task.role === "jar"
                  ? "org.gradle.api.tasks.bundling.Jar_Decorated"
                  : "org.gradle.api.DefaultTask_Decorated";
        requireNative(
          task.className === className &&
            same(
              task.actions,
              task.role === "lifecycle"
                ? []
                : [
                    task.role === "compile"
                      ? "org.gradle.api.internal.project.taskfactory.IncrementalTaskAction"
                      : "org.gradle.api.internal.project.taskfactory.StandardTaskAction",
                  ],
            ),
          "Native task implementation and actions",
        );
        if (task.role === "compile") {
          const set = name === "compileJava" ? "main" : "test";
          requireNative(
            ["compileJava", "compileTestJava"].includes(name) &&
              same(
                task.source,
                meta.sourceSets!.find((s) => s.name === set)!.java,
              ) &&
              task.destination === path.join(base, "build/classes/java", set) &&
              task.encoding === "UTF-8" &&
              task.release !== null &&
              task.java === "/opt/java/openjdk" &&
              task.javaLanguage === 25 &&
              !task.fork &&
              !task.compilerArgs.length &&
              !task.annotationProcessors.length &&
              task.classpath.every((file) => allowed.has(file)),
            "Actual native compiler inputs and policy",
          );
        } else if (task.role === "resources") {
          const set = name === "processResources" ? "main" : "test";
          requireNative(
            ["processResources", "processTestResources"].includes(name) &&
              same(
                task.source,
                meta.sourceSets!.find((s) => s.name === set)!.resources,
              ) &&
              task.destination === path.join(base, "build/resources", set),
            "Native resource accounting",
          );
        } else if (task.role === "test") {
          requireNative(
            name === "test" &&
              same(task.testClasses, [
                path.join(base, "build/classes/java/test"),
              ]) &&
              task.workingDirectory === base &&
              task.optionsClass ===
                "org.gradle.api.tasks.testing.junitplatform.JUnitPlatformOptions_Decorated" &&
              task.java === "/opt/java/openjdk" &&
              task.javaLanguage === 25 &&
              task.classpath.every((file) => allowed.has(file)) &&
              task.classpath.includes(observer) &&
              !task.jvmArgs.length &&
              identical(task.systemProperties, {
                "checktrail.junit.events": path.join(temporary, "junit.jsonl"),
              }),
            "Pinned native test runtime",
          );
          requireNative(
            task.scanForTestClasses &&
              !task.ignoreFailures &&
              !task.failFast &&
              task.failOnNoMatchingTests &&
              task.maxParallelForks === 1 &&
              task.forkEvery === 0 &&
              [
                task.includes,
                task.excludes,
                task.includePatterns,
                task.excludePatterns,
                task.includeTags,
                task.excludeTags,
                task.includeEngines,
                task.excludeEngines,
              ].every((list) => !list.length) &&
              task.xml === path.join(base, "build/test-results/test") &&
              task.xmlRequired &&
              !task.mergeReruns,
            "Unfiltered native test policy",
          );
        } else if (task.role === "lifecycle")
          requireNative(
            ["classes", "testClasses"].includes(name),
            "Native lifecycle task identity",
          );
        else requireNative(name === "jar", "Native jar identity");
      }
    }
    const taskStarts = ofType("taskStarted"),
      terminals = ofType("taskFinished");
    requireNative(
      new Set(taskStarts.map((event) => event.task.path)).size ===
        taskStarts.length &&
        new Set(terminals.map((event) => event.task)).size === terminals.length,
      "Unique native task executions",
    );
    for (const event of taskStarts)
      requireNative(
        tasks.some((task) => identical(task, event.task)),
        "Started graph task",
      );
    for (const event of terminals) {
      const started = taskStarts.find(
        (start) => start.task.path === event.task,
      );
      requireNative(
        started &&
          identical(started.task, event.snapshot) &&
          data.events.indexOf(started) < data.events.indexOf(event) &&
          !event.upToDate,
        "Unchanged executed task identity",
      );
    }
    const descriptorStarts = data.events.filter(
        (
          event,
        ): event is Extract<
          z.infer<typeof eventSchema>,
          { type: "suiteStarted" | "testStarted" }
        > => event.type === "suiteStarted" || event.type === "testStarted",
      ),
      descriptorTerminals = data.events.filter(
        (
          event,
        ): event is Extract<
          z.infer<typeof eventSchema>,
          { type: "suiteFinished" | "testFinished" }
        > => event.type === "suiteFinished" || event.type === "testFinished",
      );
    const descriptorKey = (event: { task: string; id: string }) =>
      JSON.stringify([event.task, event.id]);
    requireNative(
      descriptorStarts.length === descriptorTerminals.length &&
        new Set(descriptorStarts.map(descriptorKey)).size ===
          descriptorStarts.length &&
        new Set(descriptorTerminals.map(descriptorKey)).size ===
          descriptorTerminals.length,
      "Every native Gradle descriptor terminal",
    );
    for (const terminal of descriptorTerminals) {
      const start = descriptorStarts.find(
        (event) => descriptorKey(event) === descriptorKey(terminal),
      );
      requireNative(
        start &&
          start.type ===
            (terminal.type === "suiteFinished"
              ? "suiteStarted"
              : "testStarted") &&
          identical(
            [start.parent, start.className, start.name, start.displayName],
            [
              terminal.parent,
              terminal.className,
              terminal.name,
              terminal.displayName,
            ],
          ) &&
          data.events.indexOf(start) < data.events.indexOf(terminal),
        "Native Gradle descriptor lifecycle identity",
      );
      requireNative(
        terminal.tests ===
          terminal.passed + terminal.failed + terminal.skipped &&
          (terminal.status !== "SUCCESS" || terminal.failed === 0) &&
          (terminal.status !== "FAILURE" || terminal.failed > 0) &&
          (terminal.status !== "SKIPPED" ||
            terminal.passed + terminal.failed === 0),
        "Native Gradle terminal counts and outcome",
      );
      const descendants = descriptorTerminals
        .filter(
          (event) =>
            event.type === "testFinished" && event.task === terminal.task,
        )
        .filter((event) => {
          let current: string | null = event.id;
          const seen = new Set<string>();
          while (current !== null) {
            requireNative(
              !seen.has(current),
              "Acyclic Gradle descriptor hierarchy",
            );
            seen.add(current);
            const ancestor = descriptorStarts.find(
              (item) => item.task === event.task && item.id === current,
            );
            requireNative(ancestor, "Every native Gradle ancestor present");
            if (current === terminal.id) return true;
            current = ancestor.parent;
          }
          return false;
        });
      requireNative(
        terminal.tests === descendants.length &&
          terminal.passed ===
            descendants.reduce((sum, event) => sum + event.passed, 0) &&
          terminal.failed ===
            descendants.reduce((sum, event) => sum + event.failed, 0) &&
          terminal.skipped ===
            descendants.reduce((sum, event) => sum + event.skipped, 0),
        "Complete native Gradle suite descendants",
      );
    }
    const totals = nativeTotals();
    let partial = false;
    for (const module of invocation.config.modules.filter(
      (m) => m.kind === "java",
    )) {
      const base = path.resolve(data.workspace, module.path),
        id = gradleModulePath(module.path),
        testPath = id === ":" ? ":test" : id + ":test",
        captured = data.modules.find((m) => m.path === base)!,
        nativeTerminal = terminals.find((event) => event.task === testPath);
      try {
        const counts = reconcileNativeJUnit({
          events: data.tests.filter((event) => event.module === base),
          declarations: captured.declarations,
          classes: module.testClasses,
          base,
          output: path.join(base, "build/classes/java/test"),
          repository,
          reports: captured.reports,
        });
        const gradleTests = ofType("testFinished").filter(
            (event) => event.task === testPath,
          ),
          gradleStarts = ofType("testStarted").filter(
            (event) => event.task === testPath,
          ),
          suites = ofType("suiteFinished").filter(
            (event) => event.task === testPath && event.parent === null,
          );
        requireNative(
          nativeTerminal &&
            !nativeTerminal.skipped &&
            nativeTerminal.didWork &&
            !nativeTerminal.noSource &&
            gradleTests.length === counts.total &&
            gradleStarts.length === counts.total &&
            new Set(gradleTests.map((t) => t.id)).size === gradleTests.length &&
            suites.length === 1,
          "Native task and test terminal participation",
        );
        const gradleCounts = nativeTotals();
        for (const terminal of gradleTests) {
          const start = gradleStarts.find((s) => s.id === terminal.id);
          requireNative(
            start &&
              identical(
                [start.parent, start.className, start.name, start.displayName],
                [
                  terminal.parent,
                  terminal.className,
                  terminal.name,
                  terminal.displayName,
                ],
              ) &&
              data.events.indexOf(start) < data.events.indexOf(terminal) &&
              module.testClasses.some(
                (c) => c.className === terminal.className,
              ) &&
              terminal.tests === 1 &&
              terminal.passed + terminal.failed + terminal.skipped === 1,
            "Native Gradle test identity",
          );
          gradleCounts.total++;
          gradleCounts.passed += terminal.passed;
          gradleCounts.failed += terminal.failed;
          gradleCounts.skipped += terminal.skipped;
        }
        requireNative(
          identical(gradleCounts, counts) &&
            identical(
              {
                total: suites[0]!.tests,
                passed: suites[0]!.passed,
                failed: suites[0]!.failed,
                skipped: suites[0]!.skipped,
              },
              counts,
            ),
          "Independent Gradle JUnit totals",
        );
        const tuple = (value: {
          className: string | null;
          displayName: string;
          status: string;
        }) =>
          JSON.stringify([value.className, value.displayName, value.status]);
        const nativeCases = gradleTests.map((test) => ({
          className: test.className,
          displayName: test.displayName,
          status:
            test.status === "SUCCESS"
              ? "passed"
              : test.status === "FAILURE"
                ? "failed"
                : "skipped",
        }));
        requireNative(
          JSON.stringify(nativeCases.map(tuple).sort()) ===
            JSON.stringify(
              nativeJUnitCases(
                data.tests.filter((event) => event.module === base),
              )
                .map(tuple)
                .sort(),
            ),
          "Independent native test cases",
        );
        const xmlCases = captured.reports.flatMap((report) => {
          const className = path.basename(report.file).slice(5, -4),
            tree = new XMLParser({
              ignoreAttributes: false,
              parseAttributeValue: false,
              parseTagValue: false,
            }).parse(report.xml) as { testsuite?: Record<string, unknown> };
          requireNative(
            tree.testsuite && tree.testsuite["@_name"] === className,
            "Native XML class identity",
          );
          const raw = tree.testsuite.testcase,
            entries = Array.isArray(raw) ? raw : [raw];
          requireNative(
            entries.every(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                (entry as Record<string, unknown>)["@_classname"] === className,
            ),
            "Native XML case class identity",
          );
          return importJUnit(report.xml).cases!.map((c) => ({
            className,
            displayName: c.name,
            status: c.status,
          }));
        });
        requireNative(
          JSON.stringify(xmlCases.map(tuple).sort()) ===
            JSON.stringify(nativeCases.map(tuple).sort()),
          "Native XML test names and outcomes",
        );
        requireNative(
          counts.failed
            ? data.exitCode !== 0 &&
                nativeTerminal.failures.includes(
                  "org.gradle.api.internal.exceptions.MarkedVerificationException",
                )
            : !nativeTerminal.failures.length,
          "Native test failure agreement",
        );
        for (const key of ["total", "passed", "failed", "skipped"] as const)
          totals[key] += counts[key];
        if (counts.failed) confirmed = { ...totals };
      } catch {
        partial = true;
      }
    }
    const failures = terminals.filter((t) => t.failures.length);
    if (
      partial ||
      taskStarts.length !== tasks.length ||
      terminals.length !== tasks.length
    ) {
      if (confirmed)
        return {
          status: "failed",
          reason:
            "Reconciled Gradle test failures are retained; remaining native participation is incomplete",
          tests: confirmed,
          findingsComplete: false,
        };
      if (
        data.exitCode !== 0 &&
        failures.some((event) =>
          event.failures.includes(
            "org.gradle.api.internal.tasks.compile.CompilationFailedException",
          ),
        )
      )
        return {
          status: "failed",
          reason:
            "The native Gradle compiler rejected current source; test participation is incomplete",
          findingsComplete: false,
        };
      return incomplete;
    }
    requireNative(
      terminals.every(
        (t) =>
          !t.skipped ||
          (t.noSource &&
            t.skipMessage === "NO-SOURCE" &&
            t.snapshot.role === "resources" &&
            !t.snapshot.source.length),
      ),
      "No unexecuted required task",
    );
    if (totals.failed) {
      requireNative(
        data.exitCode !== 0 &&
          closes[0]!.failures.length > 0 &&
          failures.every((t) => t.snapshot.role === "test"),
        "Failed native build",
      );
      return {
        status: "failed",
        reason:
          "Native Gradle failures reconcile with fresh JUnit and XML results",
        tests: totals,
        findingsComplete: true,
      };
    }
    requireNative(
      data.exitCode === 0 && !closes[0]!.failures.length && !failures.length,
      "Successful native build",
    );
    if (totals.skipped)
      return {
        ...incomplete,
        reason:
          "Gradle executed tests but skipped or aborted cases leave validation incomplete",
        tests: totals,
      };
    requireNative(totals.passed > 0, "Executed non-skipped Gradle tests");
    return {
      status: "passed",
      reason:
        "Every declared Gradle Java module compiled fresh inputs and executed reconciled native tests",
      tests: totals,
      findingsComplete: true,
    };
  } catch {
    return confirmed
      ? {
          status: "failed",
          reason:
            "Reconciled Gradle test failures are retained; remaining evidence is incomplete",
          tests: confirmed,
          findingsComplete: false,
        }
      : incomplete;
  }
}
