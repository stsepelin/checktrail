import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import type {
  Check,
  CheckResult,
  ProcessResult,
  Finding,
  TestEvidence,
} from "./types.js";
import { rustEvidence } from "./rust-evidence.js";
import {
  rustWorkspaceInputSchema,
  rustWorkspacePacketSchema,
} from "./rust-workspace-schema.js";
import { rustTestArtifactSchema } from "./rust-test-native.js";
import { rustTestList, rustTestRun } from "./rust-test-events.js";
export function rustWorkspaceEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<
  CheckResult,
  "status" | "reason" | "findings" | "findingsComplete" | "tests"
> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Rust workspace evidence does not reconcile declared members, feature/target scope or native source/test evidence.",
    findingsComplete: false,
  };
  if (
    !root ||
    !check.rustBuild ||
    processes.length !== 1 ||
    check.commands.length !== 1 ||
    !["rust.cargo-check", "rust.cargo-clippy", "rust.cargo-test"].includes(
      check.id,
    )
  )
    return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("rust-workspace"),
        reason: z.enum([
          "unsupported-version",
          "source-changed",
          "native-toolchain",
          "cross-target-tests",
          "target-prerequisite",
          "workspace-members",
          "feature-prerequisite",
        ]),
      }).parse(JSON.parse(process.stdout));
      return {
        status: "unavailable",
        reason:
          "The declared Rust workspace, feature, target or installed toolchain prerequisites are unavailable.",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      reason:
        "Cargo could not resolve the requested locked profile or complete bounded workspace evidence.",
      findingsComplete: false,
    };
  try {
    const data = rustWorkspacePacketSchema.parse(JSON.parse(process.stdout));
    const input = rustWorkspaceInputSchema.parse(
      JSON.parse(check.commands[0]!.args[1]!),
    );
    if (
      input.root !== root ||
      input.project !== check.project ||
      JSON.stringify(input.scope) !== JSON.stringify(check.scope) ||
      data.sourceFingerprint !== input.sourceFingerprint ||
      !data.inputsStable ||
      (check.rustBuild.nativeToolchain
        ? data.nativeToolchainVerified !== true
        : data.nativeToolchainVerified !== null)
    )
      return incomplete;
    const mode =
      check.id === "rust.cargo-test"
        ? "test"
        : check.id === "rust.cargo-clippy"
          ? "clippy"
          : "check";
    if (
      data.project !== check.project ||
      data.mode !== mode ||
      !isDeepStrictEqual(data.selection, check.rustBuild) ||
      data.clippyVersion !== (mode === "clippy" ? "0.1.98" : null) ||
      data.rustdocVersion !== (mode === "test" ? "1.98.1" : null) ||
      !data.hostTarget
    )
      return incomplete;
    if (
      mode === "test" &&
      data.selection.target !== null &&
      data.selection.target !== data.hostTarget
    )
      return incomplete;
    const cwd = path.resolve(root, check.project),
      metadata = data.metadata;
    if (
      metadata.workspace_root !== cwd ||
      metadata.target_directory !== metadata.build_directory
    )
      return incomplete;
    const members = metadata.packages.filter((m) =>
      metadata.workspace_members.includes(m.id),
    );
    const declared = [...data.selection.workspaceMembers].sort();
    if (
      new Set(metadata.workspace_members).size !==
        metadata.workspace_members.length ||
      members.length !== declared.length ||
      members.length !== metadata.workspace_members.length ||
      new Set(members.map((m) => m.name)).size !== members.length ||
      JSON.stringify(
        members
          .map((m) => path.relative(cwd, path.dirname(m.manifest_path)) || ".")
          .sort(),
      ) !== JSON.stringify(declared) ||
      members.some(
        (m) =>
          m.manifest_path !==
            path.resolve(cwd, path.relative(cwd, m.manifest_path)) ||
          path.basename(m.manifest_path) !== "Cargo.toml",
      )
    )
      return incomplete;
    const ids = new Set(members.map((m) => m.id));
    const resolved = new Map<string, string[]>();
    for (const node of metadata.resolve.nodes) {
      if (
        resolved.has(node.id) ||
        new Set(node.features).size !== node.features.length
      )
        return incomplete;
      resolved.set(node.id, [...node.features].sort());
    }
    if (members.some((m) => !resolved.has(m.id))) return incomplete;
    for (const feature of data.selection.features) {
      const [name, value] = feature.split("/");
      const member = members.find((m) => m.name === name);
      if (
        !member ||
        !Object.hasOwn(member.features, value!) ||
        !resolved.get(member.id)!.includes(value!)
      )
        return incomplete;
    }
    const expected = check.scope.filter(
      (f) => !data.selection.excludedSources.some((e) => e.path === f),
    );
    if (
      !expected.length ||
      new Set(data.selection.excludedSources.map((e) => e.path)).size !==
        data.selection.excludedSources.length ||
      data.selection.excludedSources.some(
        (e) => !check.scope.includes(e.path),
      ) ||
      data.observedSources.some((f) => !expected.includes(f))
    )
      return incomplete;
    const sourcePaths = new Set(expected.map((f) => path.resolve(cwd, f)));
    const active = members.map((member) => ({
      member,
      targets: member.targets.filter((t) =>
        (t["required-features"] ?? []).every((f) =>
          resolved.get(member.id)!.includes(f),
        ),
      ),
    }));
    if (
      active.some(
        ({ member, targets }) =>
          !targets.length ||
          member.targets.some(
            (t) =>
              !sourcePaths.has(t.src_path) &&
              !data.selection.excludedSources.some(
                (e) => path.resolve(cwd, e.path) === t.src_path,
              ),
          ),
      )
    )
      return incomplete;
    const events = z
      .array(z.object({ reason: z.string() }).passthrough())
      .max(20000)
      .parse(
        data.execution.stdout
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s)),
      );
    if (
      mode === "clippy" &&
      events.some((e) => {
        if (e.reason !== "compiler-message") return false;
        const parsed = z
          .object({
            message: z.object({
              level: z.string(),
              message: z.string(),
              code: z.unknown(),
              spans: z.array(
                z.object({ file_name: z.string(), is_primary: z.boolean() }),
              ),
            }),
          })
          .parse(e);
        const message = parsed.message;
        const configs = [
          cwd,
          ...members.map((m) => path.dirname(m.manifest_path)),
        ].flatMap((dir) => [
          path.join(dir, "clippy.toml"),
          path.join(dir, ".clippy.toml"),
        ]);
        return (
          message.level === "error" &&
          message.code === null &&
          message.message.startsWith(
            "error reading Clippy's configuration file:",
          ) &&
          message.spans.some(
            (span) =>
              span.is_primary &&
              configs.includes(path.resolve(cwd, span.file_name)),
          )
        );
      })
    )
      return {
        status: "error",
        reason:
          "Clippy could not read a declared workspace configuration; analysis is incomplete.",
        findingsComplete: false,
      };
    const featuresMatch = (evidenceEvents: typeof events) =>
      evidenceEvents
        .filter(
          (e) =>
            e.reason === "compiler-artifact" && ids.has(e.package_id as string),
        )
        .every((e) => {
          const native = z
            .object({ package_id: z.string(), features: z.array(z.string()) })
            .parse(e);
          return (
            JSON.stringify([...native.features].sort()) ===
            JSON.stringify(resolved.get(native.package_id))
          );
        });
    const targetArtifactsMatch = (evidenceEvents: typeof events) =>
      evidenceEvents
        .filter(
          (e) =>
            e.reason === "compiler-artifact" && ids.has(e.package_id as string),
        )
        .every((e) => {
          const artifact = z
            .object({
              target: z.object({ kind: z.array(z.string()) }),
              filenames: z.array(z.string()).min(1),
            })
            .parse(e);
          if (
            artifact.target.kind.some(
              (k) => k === "custom-build" || k === "proc-macro",
            )
          )
            return true;
          const output = path.join(
            metadata.target_directory,
            data.selection.target ?? data.hostTarget,
          );
          return artifact.filenames.every((f) => {
            const rel = path.relative(output, f);
            return (
              rel.length > 0 &&
              rel !== ".." &&
              !rel.startsWith(".." + path.sep) &&
              !path.isAbsolute(rel)
            );
          });
        });
    if (!featuresMatch(events) || !targetArtifactsMatch(events))
      return incomplete;
    const findings: Finding[] = [];
    const seen = new Set<string>();
    let compilerStatus: CheckResult["status"] = "passed",
      compilerReason =
        "Every declared Rust workspace member has fresh compiler target/source coverage.";
    for (const { member, targets } of active) {
      const result = rustEvidence(
        {
          ...check,
          id: mode === "clippy" ? "rust.cargo-clippy" : "rust.cargo-check",
          scope: expected,
        },
        [
          {
            ...process,
            stdout: JSON.stringify({
              version: mode === "clippy" ? 2 : 1,
              ...(mode === "clippy"
                ? {
                    mode: "clippy",
                    clippyVersion: "0.1.98",
                    forcedLintGroup: "clippy::all",
                  }
                : {}),
              cargoVersion: data.cargoVersion,
              rustcVersion: data.rustcVersion,
              project: check.project,
              packageId: member.id,
              exitCode: data.execution.exitCode,
              targets,
              events,
              observedSources: data.observedSources,
              depInfoCount: data.depInfoCount,
              scopeError: data.scopeError,
            }),
          },
        ],
        root,
      );
      for (const finding of result.findings ?? []) {
        const key = JSON.stringify(finding);
        if (!seen.has(key)) {
          findings.push(finding);
          seen.add(key);
        }
      }
      if (
        result.status === "failed" ||
        (compilerStatus !== "failed" && result.status !== "passed")
      ) {
        compilerStatus = result.status;
        compilerReason = result.reason;
      }
    }
    const compiler = {
      status: compilerStatus,
      reason: compilerReason,
      findings,
      findingsComplete:
        compilerStatus === "passed" ||
        (mode === "clippy" &&
          compilerStatus === "failed" &&
          findings.every((f) => f.file !== undefined) &&
          data.execution.exitCode === 0),
    };
    if (mode !== "test") {
      if (data.tests !== null || data.documentation !== null) return incomplete;
      return compiler;
    }
    if (data.tests === null)
      return compilerStatus === "passed" ? incomplete : compiler;
    if (data.tests.build.exitCode !== 0)
      return {
        status: "error",
        reason:
          "Cargo could not compile/link workspace test artifacts; test execution is incomplete.",
        findingsComplete: false,
      };
    if (data.tests.error !== null) return incomplete;
    const build = z
      .array(z.object({ reason: z.string() }).passthrough())
      .max(20000)
      .parse(
        data.tests.build.stdout
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s)),
      );
    if (
      build.at(-1)?.reason !== "build-finished" ||
      build.at(-1)?.success !== true ||
      build.filter((e) => e.reason === "build-finished").length !== 1 ||
      !featuresMatch(build) ||
      !targetArtifactsMatch(build)
    )
      return incomplete;
    const artifacts = build
      .filter((e) => e.reason === "compiler-artifact")
      .map((e) => rustTestArtifactSchema.parse(e))
      .filter(
        (e) =>
          ids.has(e.package_id) &&
          e.profile.test &&
          e.executable !== null &&
          !e.target.kind.includes("custom-build"),
      );
    const same = (
      a: {
        name: string;
        src_path: string;
        kind: string[];
        test: boolean;
        doctest: boolean;
      },
      b: typeof a,
    ) =>
      a.name === b.name &&
      a.src_path === b.src_path &&
      JSON.stringify(a.kind) === JSON.stringify(b.kind) &&
      a.test === b.test &&
      a.doctest === b.doctest;
    const groups = data.tests.groups;
    const identities = groups.map((g) =>
      JSON.stringify([g.target.name, g.target.src_path, g.target.kind]),
    );
    if (
      data.tests.outputDirectory !== metadata.target_directory ||
      groups.length !== artifacts.length ||
      new Set(identities).size !== groups.length ||
      groups.some(
        (g) =>
          g.kind !== "libtest" ||
          !artifacts.some(
            (a) =>
              same(a.target, g.target) &&
              a.executable === g.executable &&
              !a.fresh,
          ),
      ) ||
      active.some(({ targets }) =>
        targets.some(
          (t) =>
            t.test &&
            !t.kind.includes("custom-build") &&
            !groups.some((g) => same(g.target, t)),
        ),
      ) ||
      artifacts.some(
        (a) =>
          !active.some(
            ({ member, targets }) =>
              a.package_id === member.id &&
              targets.some((t) => same(t, a.target)),
          ),
      )
    )
      return incomplete;
    const totals: TestEvidence = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const perMember = new Map(members.map((m) => [m.id, 0]));
    const add = (counts: TestEvidence) => {
      for (const key of ["total", "passed", "failed", "skipped"] as const)
        totals[key] += counts[key];
      if (totals.total > 1000) throw Error("Rust test case limit");
    };
    for (const group of groups) {
      if (
        !group.executable ||
        !group.listed ||
        !group.ignoredListed ||
        !group.execution
      )
        return incomplete;
      const relative = path.relative(
        data.tests.outputDirectory,
        group.executable,
      );
      if (
        !relative ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        return incomplete;
      const names = rustTestList(group.listed, false),
        ignored = rustTestList(group.ignoredListed, false);
      const result = rustTestRun(group.execution, names, ignored, false);
      add(result.tests);
      const artifact = artifacts.find((a) => same(a.target, group.target))!;
      perMember.set(
        artifact.package_id,
        perMember.get(artifact.package_id)! +
          result.tests.passed +
          result.tests.failed,
      );
    }
    const docTargets = active.flatMap(({ member, targets }) =>
      targets.filter((t) => t.doctest).map((target) => ({ member, target })),
    );
    if (Boolean(data.documentation) !== Boolean(docTargets.length))
      return incomplete;
    if (data.documentation) {
      const doc = data.documentation;
      const names = rustTestList(doc.listed, true),
        ignored = rustTestList(doc.ignoredListed, true);
      let run;
      try {
        run = rustTestRun(doc.execution, names, ignored, true, true);
      } catch {
        if (totals.failed)
          return {
            status: "failed",
            reason:
              "Native workspace test cases failed; documentation execution is incomplete and aggregate test counts remain unknown.",
            findings,
            findingsComplete: false,
          };
        return incomplete;
      }
      add(run.tests);
      for (const name of names) {
        const file = expected.find(
          (f) =>
            name.startsWith(f + " - ") && / \(line [1-9][0-9]*\)$/.test(name),
        );
        if (!file) return incomplete;
        const absolute = path.resolve(cwd, file);
        const owners = members
          .filter((m) => {
            const rel = path.relative(path.dirname(m.manifest_path), absolute);
            return (
              rel !== ".." &&
              !rel.startsWith(".." + path.sep) &&
              !path.isAbsolute(rel)
            );
          })
          .sort((a, b) => b.manifest_path.length - a.manifest_path.length);
        const matches = docTargets.filter((d) => d.member.id === owners[0]?.id);
        if (matches.length !== 1) return incomplete;
        if (!ignored.includes(name))
          perMember.set(
            matches[0]!.member.id,
            perMember.get(matches[0]!.member.id)! + 1,
          );
      }
    }
    if (totals.failed)
      return {
        status: "failed",
        reason:
          "Native workspace Rust cases failed; compiler/source and ignored accounting remain separate.",
        tests: totals,
        findings,
        findingsComplete: compilerStatus === "passed" && totals.skipped === 0,
      };
    if (compilerStatus !== "passed")
      return { ...compiler, tests: totals, findingsComplete: false };
    if (
      !totals.passed ||
      totals.skipped ||
      [...perMember.values()].some((n) => n === 0)
    )
      return {
        ...incomplete,
        reason:
          "A Rust workspace member has no completed native cases, or native tests were empty or ignored.",
        tests: totals,
      };
    return {
      status: "passed",
      reason:
        "All declared Rust workspace members reconcile fresh compilation, native feature scope, exact test listings and terminal cases.",
      tests: totals,
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
