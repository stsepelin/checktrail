import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { helmRequire, helmYaml } from "./helm.js";
import {
  helmExtensionsGraph,
  helmExtensionsSchema,
  type HelmExtensionsConfig,
} from "./helm-extensions-contract.js";
import { helmExtensionsJson } from "./helm-extensions-physical.js";
export function helmExtensionsDebug(
  config: HelmExtensionsConfig,
  stderr: string,
  chart: string,
) {
  const boundary = stderr.indexOf("\nError: "),
    prefix = boundary < 0 ? stderr : stderr.slice(0, boundary + 1),
    error = boundary < 0 ? "" : stderr.slice(boundary + 1),
    lines = prefix.trimEnd().split("\n"),
    graph = helmExtensionsGraph(config);
  helmRequire(
    lines.length === 2 + 3 * graph.length,
    "Complete native debug chart/schema cohort required",
  );
  helmRequire(
    lines[0] === 'level=DEBUG msg="Original chart version" version=""' &&
      lines[1] === 'level=DEBUG msg="Chart path" path=' + chart,
    "Native debug initialization roles differ",
  );
  for (const [index, instance] of graph.entries()) {
    const c = config.charts.find((c) => c.id === instance.id)!;
    helmRequire(
      lines[2 + index * 3] ===
        'level=DEBUG msg="chart name" chart-name=' + instance.name,
      "Native chart alias order differs",
    );
    const match =
      /^level=DEBUG msg="unmarshalled JSON schema" schema=(.+)$/.exec(
        lines[3 + index * 3]!,
      );
    helmRequire(match, "Native full schema role missing");
    const text = helmExtensionsJson(match[1]!) as unknown;
    helmRequire(typeof text === "string", "Native schema text differs");
    helmRequire(
      isDeepStrictEqual(helmExtensionsJson(text), helmExtensionsSchema(c)),
      "Complete native chart schema differs",
    );
    helmRequire(
      lines[4 + index * 3] ===
        'level=DEBUG msg="number of dependencies in the chart" chart=' +
          instance.name +
          " dependencies=" +
          c.dependencies.length,
      "Native dependency participation differs",
    );
  }
  return error;
}
export function helmExtensionsSources(
  config: HelmExtensionsConfig,
  start = config.charts[0]!.id,
) {
  const sources = new Map<string, { file: string; lines: string[] }>();
  for (const instance of helmExtensionsGraph(config, start)) {
    const c = config.charts.find((c) => c.id === instance.id)!;
    for (const [file, lines] of Object.entries(c.templates))
      sources.set(instance.address + "/" + file, {
        file: path.posix.join(c.directory, file),
        lines,
      });
  }
  return sources;
}
export function helmExtensionsRendered(
  config: HelmExtensionsConfig,
  stdout: string,
) {
  const sources = helmExtensionsSources(config),
    remaining = new Set(sources.keys()),
    results: {
      source: string;
      file: string;
      body: string;
      validYaml: boolean;
      identity?: string;
    }[] = [];
  const chunks = stdout.split(/(?=^---\n# Source: )/m);
  helmRequire(
    chunks.length === sources.size,
    "Complete rendered instance/template cohort required",
  );
  for (const chunk of chunks) {
    const header = /^---\n# Source: ([^\n]+)\n/.exec(chunk);
    helmRequire(
      header && remaining.delete(header[1]!),
      "Native template source repeated missing or foreign",
    );
    const model = sources.get(header[1]!)!,
      body = chunk.slice(header[0].length).trimEnd(),
      lines = body.split("\n");
    helmRequire(
      lines.length === 2 * model.lines.length,
      "Physical/rendered line count differs",
    );
    for (const [index, physical] of model.lines.entries()) {
      helmRequire(
        lines[2 * index] === "# checktrail-source-line:" + (index + 1),
        "Native physical/rendered line marker differs",
      );
      const rendered = lines[2 * index + 1]!,
        normalized =
          index === model.lines.length - 1 ? physical.trimEnd() : physical,
        parts = normalized.split(/\{\{.*?\}\}/g);
      let position = 0;
      for (const [partIndex, part] of parts.entries()) {
        if (!part) continue;
        const found = rendered.indexOf(part, position);
        helmRequire(
          found >= position && (partIndex !== 0 || found === 0),
          "Rendered literal source spine differs",
        );
        position = found + part.length;
        if (partIndex === parts.length - 1)
          helmRequire(
            position === rendered.length,
            "Rendered trailing source spine differs",
          );
      }
      if (parts.length === 1)
        helmRequire(
          rendered === normalized,
          "Literal physical/rendered line differs",
        );
    }
    let validYaml = false,
      identity: string | undefined;
    try {
      const value = helmYaml(body + "\n").value as {
        apiVersion?: unknown;
        kind?: unknown;
        metadata?: { name?: unknown; namespace?: unknown };
      };
      helmRequire(
        typeof value.apiVersion === "string" &&
          value.apiVersion &&
          typeof value.kind === "string" &&
          value.kind &&
          typeof value.metadata?.name === "string" &&
          value.metadata.name &&
          (value.metadata.namespace === undefined ||
            typeof value.metadata.namespace === "string"),
        "Rendered resource identity incomplete",
      );
      identity = JSON.stringify([
        value.apiVersion,
        value.kind,
        value.metadata.namespace ?? "",
        value.metadata.name,
      ]);
      validYaml = true;
    } catch {
      /* Malformed rendering is retained for native YAML diagnostics. */
    }
    results.push({
      source: header[1]!,
      file: model.file,
      body,
      validYaml,
      ...(identity === undefined ? {} : { identity }),
    });
  }
  helmRequire(remaining.size === 0, "Rendered template omitted");
  return results;
}
export function helmExtensionsPhysical(
  config: HelmExtensionsConfig,
  diagnostic: string,
  start = config.charts[0]!.id,
) {
  const sources = helmExtensionsSources(config, start);
  const parse = /^parse error at \(([^:\n]+):(\d+)\): ([^\n]+)$/.exec(
    diagnostic,
  );
  const execute =
    /^([^:\n]+):(\d+):(\d+)\n {2}executing "([^"\n]+)" at <([^\n]+)>:\n {4}([^\n]+)$/.exec(
      diagnostic,
    );
  helmRequire(
    parse || execute,
    "Verified Go-template physical diagnostic required",
  );
  const source = (parse ?? execute)![1]!,
    line = Number((parse ?? execute)![2]),
    model = sources.get(source);
  helmRequire(
    model && line >= 1 && line <= model.lines.length * 2 && line % 2 === 0,
    "Native physical template line differs",
  );
  const physical = model.lines[line / 2 - 1]!;
  helmRequire(
    physical.includes("{{"),
    "Native diagnostic does not reach an action",
  );
  if (execute) {
    const column = Number(execute[3]);
    helmRequire(
      execute[4] === source &&
        column >= 1 &&
        column <= Buffer.byteLength(physical) + 1 &&
        physical.includes(execute[5]!),
      "Native physical execution address differs",
    );
  }
  return { file: model.file, line, message: parse ? parse[3]! : execute![6]! };
}
export function helmExtensionsLint(
  config: HelmExtensionsConfig,
  stdout: string,
  stderr: string,
  exitCode: number,
) {
  const directories = config.charts
      .map((c) => (c.directory === "." ? "chart" : "chart/" + c.directory))
      .toSorted(),
    headers = [...stdout.matchAll(/^==> Linting ([^\n]+)\n/gm)];
  helmRequire(
    headers[0]?.index === 0 &&
      isDeepStrictEqual(
        headers.map((h) => h[1]),
        directories,
      ),
    "Complete physical subchart lint cohort differs",
  );
  const records: {
    directory: string;
    errors: { file: string; message: string }[];
  }[] = [];
  const summary = /\n(\d+) chart\(s\) linted, 0 chart\(s\) failed\n$/.exec(
    stdout,
  );
  if (exitCode === 0)
    helmRequire(
      summary && Number(summary[1]) === directories.length && !stderr,
      "Native lint success accounting differs",
    );
  else
    helmRequire(
      exitCode === 1 && !summary,
      "Native lint failure accounting differs",
    );
  for (const [index, header] of headers.entries()) {
    const start = header.index! + header[0].length,
      end =
        index + 1 < headers.length
          ? headers[index + 1]!.index!
          : (summary?.index ?? stdout.length);
    const body = stdout.slice(start, end),
      prefix = "[INFO] Chart.yaml: icon is recommended\n";
    helmRequire(
      body.startsWith(prefix),
      "Unexpected chart metadata lint output",
    );
    const remainder = body.slice(prefix.length).trimEnd(),
      errors: { file: string; message: string }[] = [];
    if (remainder) {
      helmRequire(
        remainder.startsWith("[ERROR] ") &&
          !remainder.includes("[WARNING]") &&
          !remainder.includes("[WARN]") &&
          !remainder.includes("[INFO]"),
        "Native lint messages unaccounted",
      );
      for (const part of remainder.split(/(?=^\[ERROR\] )/m)) {
        const m = /^\[ERROR\] ([^:\n]+): ([\s\S]+)$/.exec(part.trimEnd());
        helmRequire(m, "Native lint error shape differs");
        errors.push({ file: m[1]!, message: m[2]!.trimEnd() });
      }
    }
    records.push({ directory: header[1]!, errors });
  }
  const failed = records.filter((r) => r.errors.length).length;
  helmRequire(
    exitCode === (failed ? 1 : 0),
    "Native lint status and chart errors disagree",
  );
  if (failed)
    helmRequire(
      stderr ===
        "Error: " +
          directories.length +
          " chart(s) linted, " +
          failed +
          " chart(s) failed\n",
      "Native failed chart count differs",
    );
  return records;
}

export function helmExtensionsValueErrorCohort(text: string) {
  const prefix =
    "Error: values don't meet the specifications of the schema(s) in the following chart(s):\n";
  helmRequire(text.startsWith(prefix), "Native values error role differs");
  const groups: { name: string; messages: string[] }[] = [];
  for (const line of text.slice(prefix.length).trimEnd().split("\n")) {
    if (!line) continue;
    const name = /^([a-z][a-z0-9-]{0,62}):$/.exec(line);
    if (name) {
      groups.push({ name: name[1]!, messages: [] });
      continue;
    }
    helmRequire(
      groups.length && line.startsWith("- at '"),
      "Native values error line unaccounted",
    );
    groups.at(-1)!.messages.push(line);
  }
  helmRequire(
    groups.length && groups.every((group) => group.messages.length),
    "Empty native values error cohort",
  );
  return groups
    .map((group) =>
      JSON.stringify({ name: group.name, messages: group.messages.toSorted() }),
    )
    .toSorted();
}
