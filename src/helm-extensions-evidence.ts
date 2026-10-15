import path from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { kubePointerLine } from "./kubeconform.js";
import { mavenHash } from "./maven.js";
import {
  helmRequire,
  helmBinarySha256,
  helmVersionArgs,
  helmRenderArgs,
} from "./helm.js";
import {
  helmExtensionsGraph,
  helmExtensionsLintArgs,
  type HelmExtensionsConfig,
} from "./helm-extensions-contract.js";
import {
  helmExtensionsInvocationSchema,
  helmExtensionsVerify,
  helmExtensionsRegular,
  helmExtensionsJson,
} from "./helm-extensions-physical.js";
import { helmExtensionsPacketSchema } from "./helm-extensions-packet.js";
import {
  helmExtensionsDebug,
  helmExtensionsSources,
  helmExtensionsRendered,
  helmExtensionsPhysical,
  helmExtensionsLint,
  helmExtensionsValueErrorCohort,
} from "./helm-extensions-native.js";
import { helmExtensionsValueIssues } from "./helm-extensions-values.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const same = (a: unknown, b: unknown, message: string) =>
  helmRequire(isDeepStrictEqual(a, b), message);
export function helmExtensionsEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Helm extension evidence is incomplete stale or inconsistent with its physical charts aliases values constraints rendered source or native execution cohort.",
    findingsComplete: false,
  };
  try {
    helmRequire(
      check.id === "infrastructure.helm-extensions" &&
        check.commands.length === 1 &&
        processes.length === 1,
      "Execution accounting differs",
    );
    const command = check.commands[0]!,
      process = processes[0]!;
    helmRequire(
      !process.stderr &&
        !process.truncated &&
        !process.cancelled &&
        !process.timedOut &&
        !process.errorCode &&
        !process.signal,
      "Native execution incomplete",
    );
    helmRequire(
      root &&
        path.isAbsolute(root) &&
        realpathSync(root) === root &&
        command.args.length === 3 &&
        command.args[1] === root &&
        path.basename(command.args[0]!) === "helm-extensions-runner.js",
      "Current root/command differs",
    );
    const directory = path.join(root!, check.project);
    helmRequire(
      directory === root || directory.startsWith(root + path.sep),
      "Project escapes root",
    );
    const invocation = helmExtensionsInvocationSchema.parse(
        helmExtensionsJson(command.args[2]!),
      ),
      current = helmExtensionsVerify(directory, invocation);
    same(check.scope, current.files, "Planned source scope differs");
    same(process.command, command, "Executed collector command differs");
    if (process.exitCode === 3) {
      z.strictObject({
        unavailable: z.literal("helm-extensions"),
        reason: z.literal("pinned-prerequisite"),
      }).parse(helmExtensionsJson(process.stdout));
      return {
        status: "unavailable",
        reason:
          "Pinned Helm prerequisites are missing incompatible or changed.",
        findingsComplete: false,
      };
    }
    helmRequire(process.exitCode === 0, "Collector did not complete");
    const packet = helmExtensionsPacketSchema.parse(
      helmExtensionsJson(process.stdout),
    );
    helmRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        path.basename(packet.temporary).startsWith("helm-extensions-"),
      "Owned temporary root differs",
    );
    same(
      packet.source,
      path.join(packet.temporary, "source"),
      "Owned source role differs",
    );
    same(
      packet.workspace,
      path.join(packet.temporary, "native"),
      "Owned workspace role differs",
    );
    same(
      packet.chart,
      path.join(packet.workspace, "chart"),
      "Owned chart role differs",
    );
    same(
      packet.inputSha256,
      mavenHash(JSON.stringify(invocation)),
      "Invocation digest differs",
    );
    same(
      packet.sourceInputs,
      invocation.inputs.map((i) => ({ ...i, afterSha256: i.sha256 })),
      "Frozen source cohort differs",
    );
    same(
      packet.sourceFiles,
      current.files.toSorted(),
      "Source copy file cohort differs",
    );
    same(
      packet.nativeFiles,
      Object.keys(current.rendered).toSorted(),
      "Native chart file cohort differs",
    );
    same(
      packet.nativeInputs,
      Object.entries(current.rendered)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([file, text]) => ({
          path: file,
          sha256: mavenHash(text),
          afterSha256: mavenHash(text),
        })),
      "Native chart byte cohort differs",
    );
    helmRequire(
      path.isAbsolute(packet.tool.entry) &&
        path.isAbsolute(packet.tool.resolved) &&
        realpathSync(packet.tool.entry) === packet.tool.resolved,
      "Current tool alias differs",
    );
    same(packet.tool.sha256, helmBinarySha256, "Tool pin differs");
    same(packet.tool.afterSha256, packet.tool.sha256, "Tool changed");
    const tool = helmExtensionsRegular(packet.tool.resolved, 128 * 1024 * 1024);
    same(packet.tool.bytes, tool.length, "Current tool size differs");
    same(mavenHash(tool), packet.tool.sha256, "Current tool changed");
    for (const [index, args] of [
      helmVersionArgs,
      helmExtensionsLintArgs,
      helmRenderArgs,
      [...helmRenderArgs, "--debug"],
    ].entries()) {
      const r = packet.receipts[index]!;
      same(
        r.phase,
        ["version", "lint", "render", "debug"][index],
        "Native phase order differs",
      );
      same(r.executable, packet.tool.entry, "Native executable differs");
      same(r.args, args, "Fixed native arguments differ");
      same(r.stdoutSha256, mavenHash(r.stdout), "Native stdout changed");
      same(r.stderrSha256, mavenHash(r.stderr), "Native stderr changed");
    }
    const [version, lint, render, debug] = packet.receipts;
    helmRequire(
      version!.exitCode === 0 &&
        version!.stdout === "v4.3.0" &&
        !version!.stderr,
      "Native version differs",
    );
    const physicalLint = helmExtensionsLint(
        current.config,
        lint!.stdout,
        lint!.stderr,
        lint!.exitCode,
      ),
      debugError = helmExtensionsDebug(
        current.config,
        debug!.stderr,
        packet.chart,
      );
    same(render!.exitCode, debug!.exitCode, "Native render outcomes disagree");
    helmRequire(
      [0, 1].includes(render!.exitCode),
      "Native render did not complete",
    );
    const normalError = render!.stderr
      .replace(/\nUse --debug flag to render out invalid YAML\n$/, "")
      .trimEnd();
    if (debugError.startsWith("Error: values don't meet"))
      same(
        helmExtensionsValueErrorCohort(debugError),
        helmExtensionsValueErrorCohort(normalError),
        "Native render/debug values diagnostic cohorts disagree",
      );
    else
      same(
        debugError.trimEnd(),
        normalError,
        "Native render/debug diagnostics disagree",
      );
    const findings: Finding[] = [];
    const valueFindings = (
      config: HelmExtensionsConfig,
      text: string,
      start = config.charts[0]!.id,
      own = false,
    ) => {
      const selected = config.charts.find((chart) => chart.id === start)!;
      const localFindings: Finding[] = [];
      const prefix =
        "values don't meet the specifications of the schema(s) in the following chart(s):\n";
      helmRequire(
        text.startsWith(prefix),
        "Native values diagnostic role differs",
      );
      const expected = helmExtensionsValueIssues(config, start).filter(
          (issue) => !own || issue.address === selected.name,
        ),
        remaining = [...expected];
      let name = "";
      for (const line of text.slice(prefix.length).trimEnd().split("\n")) {
        if (!line) continue;
        const header = /^([a-z][a-z0-9-]{0,62}):$/.exec(line);
        if (header) {
          name = header[1]!;
          helmRequire(
            helmExtensionsGraph(config, start).some((i) => i.name === name),
            "Foreign native values chart",
          );
          continue;
        }
        helmRequire(
          name && line.startsWith("- at '"),
          "Native values message unaccounted",
        );
        const index = remaining.findIndex(
          (i) => i.name === name && i.message === line,
        );
        helmRequire(
          index >= 0,
          "Native values diagnostic disagrees with current coalesced values/schema",
        );
        const issue = remaining.splice(index, 1)[0]!,
          source = current.rendered[issue.origin.file];
        helmRequire(source, "Physical value/schema origin missing");
        const lineNumber = kubePointerLine(
          {
            file: issue.origin.file,
            index: 0,
            text: source,
            sha256: mavenHash(source),
            kind: "values",
            version: "1",
            line: 1,
            name: "values",
          },
          issue.origin.pointer,
        );
        localFindings.push({
          ruleId: "helm/values-extensions",
          level: "error",
          file: issue.origin.file,
          line: lineNumber,
          message:
            "Native Helm rejected " + issue.address + ": " + issue.message,
        });
      }
      helmRequire(
        expected.length > 0 && remaining.length === 0,
        "Complete native values error cohort differs",
      );
      return localFindings;
    };
    if (render!.exitCode === 0) {
      helmRequire(
        !render!.stderr &&
          !debugError &&
          helmExtensionsValueIssues(current.config).length === 0,
        "Passing native outcome has incomplete or conflicting lint/values evidence",
      );
      const rendered = helmExtensionsRendered(current.config, render!.stdout),
        debugged = helmExtensionsRendered(current.config, debug!.stdout);
      same(
        rendered.toSorted((a, b) => a.source.localeCompare(b.source)),
        debugged.toSorted((a, b) => a.source.localeCompare(b.source)),
        "Native render/debug bodies disagree",
      );
      helmRequire(
        rendered.every((r) => r.validYaml) &&
          new Set(rendered.map((r) => r.identity)).size === rendered.length,
        "Rendered identity is invalid or repeated",
      );
    } else {
      helmRequire(
        !render!.stdout && debugError.startsWith("Error: "),
        "Native failure accounting differs",
      );
      const diagnostic = debugError.slice("Error: ".length).trimEnd();
      if (diagnostic.startsWith("values don't meet")) {
        helmRequire(
          !debug!.stdout,
          "Native schema failure unexpectedly rendered resources",
        );
        findings.push(...valueFindings(current.config, diagnostic));
      } else if (diagnostic.startsWith("YAML parse error on ")) {
        helmRequire(
          helmExtensionsValueIssues(current.config).length === 0,
          "Unaccounted values failures",
        );
        const m =
          /^YAML parse error on ([^:\n]+): error converting YAML to JSON: yaml: line (\d+): ([^\n]+)$/.exec(
            diagnostic,
          );
        helmRequire(m, "Verified rendered YAML diagnostic required");
        const rendered = helmExtensionsRendered(current.config, debug!.stdout),
          item = rendered.find((r) => r.source === m[1]);
        helmRequire(
          item && !item.validYaml,
          "Native rendered diagnostic source differs",
        );
        const line = Number(m[2]);
        helmRequire(
          line >= 1 && line <= item.body.split("\n").length,
          "Native rendered diagnostic line bound differs",
        );
        const source = helmExtensionsSources(current.config).get(item.source)!;
        helmRequire(
          line <= source.lines.length * 2,
          "Verified physical/rendered source marker address required",
        );
        findings.push({
          ruleId: "helm/rendered-yaml-extensions",
          level: "error",
          file: item.file,
          line,
          message:
            "Native Helm rendered YAML parse failed at verified rendered/physical line " +
            line +
            ": " +
            m[3],
        });
      } else {
        helmRequire(
          debug!.stdout === "\n" &&
            helmExtensionsValueIssues(current.config).length === 0,
          "Unaccounted native template failure output",
        );
        const address = helmExtensionsPhysical(current.config, diagnostic);
        findings.push({
          ruleId: "helm/template-extensions",
          level: "error",
          ...address,
        });
      }
    }
    // Every physical chart lint outcome must be understood as well as the root's
    // render error. A native first-error abort is not an exhaustive semantic audit.
    for (const r of physicalLint) {
      const c = current.config.charts.find(
        (c) =>
          (c.directory === "." ? "chart" : "chart/" + c.directory) ===
          r.directory,
      )!;
      for (const error of r.errors) {
        if (error.file === "values.yaml") {
          findings.push(
            ...valueFindings(
              current.config,
              "values don't meet the specifications of the schema(s) in the following chart(s):\n" +
                c.name +
                ":\n" +
                error.message,
              c.id,
              true,
            ),
          );
          continue;
        }
        if (error.file === "templates/") {
          if (error.message.startsWith("values don't meet"))
            findings.push(
              ...valueFindings(current.config, error.message, c.id),
            );
          else {
            const address = helmExtensionsPhysical(
              current.config,
              error.message,
              c.id,
            );
            findings.push({
              ruleId: "helm/template-lint-extensions",
              level: "error",
              ...address,
            });
          }
          continue;
        }
        const yaml =
          /^unable to parse YAML: error converting YAML to JSON: yaml: line (\d+): ([^\n]+)$/.exec(
            error.message,
          );
        helmRequire(
          Object.hasOwn(c.templates, error.file) && yaml,
          "Unknown physical lint source diagnostic",
        );
        const line = Number(yaml[1]);
        helmRequire(
          line >= 1 && line <= c.templates[error.file]!.length * 2,
          "Physical lint YAML diagnostic line bound differs",
        );
        findings.push({
          ruleId: "helm/physical-yaml-lint-extensions",
          level: "error",
          file: path.posix.join(c.directory, error.file),
          line,
          message:
            "Native Helm physical chart lint rejected rendered YAML: " +
            yaml[2],
        });
      }
    }
    if (render!.exitCode === 0 && lint!.exitCode === 0) {
      helmRequire(
        findings.length === 0,
        "Passing native outcome has unaccounted findings",
      );
      return {
        status: "passed",
        reason:
          "All declared physical and aliased transitive application charts completed native strict lint and client-only rendering with current source-bound participation; Kubernetes API/schema validity is not assessed.",
        findings: [],
        findingsComplete: true,
      };
    }
    helmRequire(
      findings.length > 0,
      "Native failed outcome has no bound finding",
    );
    return {
      status: "failed",
      reason:
        "Native Helm rejected current source-bound values Go-template or rendered YAML errors within the declared local chart graph; native first-error aborts remain visible.",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
