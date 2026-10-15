import assert from "node:assert/strict";
import { test } from "node:test";
import {
  helmExtensionsConfig,
  helmExtensionsFiles,
} from "./helm-extensions-fixture.js";
import {
  helmExtensionsAction,
  helmExtensionsGraph,
  helmExtensionsRender,
} from "../src/helm-extensions-contract.js";
import { helmYaml } from "../src/helm.js";
test("Helm extension passive contract expands aliased transitive instances with every physical chart constraint and source marker", () => {
  const c = helmExtensionsConfig(),
    graph = helmExtensionsGraph(c),
    files = helmExtensionsFiles(c);
  assert.deepEqual(
    graph.map((i) => [i.id, i.name, i.address]),
    [
      ["root", "original-root", "original-root"],
      ["worker", "first", "original-root/charts/first"],
      ["leaf", "leaf", "original-root/charts/first/charts/leaf"],
      ["worker", "second", "original-root/charts/second"],
      ["leaf", "leaf", "original-root/charts/second/charts/leaf"],
    ],
  );
  assert.equal(Object.keys(files).length, 13);
  assert.deepEqual(
    helmExtensionsGraph(c, "worker").map((i) => i.address),
    ["worker", "worker/charts/leaf"],
  );
  for (const chart of c.charts) {
    const prefix = chart.directory === "." ? "" : chart.directory + "/";
    const schema = JSON.parse(files[prefix + "values.schema.json"]!) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(schema.required, ["count", "label"]);
    assert.deepEqual(schema.properties.global, {
      type: "object",
      additionalProperties: false,
    });
    assert.deepEqual(schema.properties.count, {
      type: "integer",
      minimum: 1,
      maximum: 5,
    });
    assert.deepEqual(
      helmYaml(files[prefix + "values.yaml"]!).value,
      chart.values,
    );
    for (const [file, lines] of Object.entries(chart.templates))
      assert.equal(
        files[prefix + file],
        lines
          .map(
            (line, i) =>
              "# checktrail-source-line:" + (i + 1) + "\n" + line + "\n",
          )
          .join(""),
      );
  }
  const original = helmExtensionsRender(c);
  c.charts[1]!.values.count = 0;
  assert.notDeepEqual(helmExtensionsRender(c), original); // Native tooling, not planning, checks the constraint.
  assert.doesNotThrow(() =>
    helmExtensionsAction(
      '  identifier: {{ default "original" .Values.source_name | quote }}',
    ),
  );
  assert.doesNotThrow(() => helmExtensionsAction("  invalid: {{ if }}"));
  for (const line of [
    '{{ lookup "v1" "Secret" "original" "key" }}',
    "{{ tpl .Values.label . }}",
    '{{ include "foreign" . }}',
    "{{- .Values.label }}",
    "{{ .Values.label -}}",
    "{{ if .Values.label }}",
    "{{ .Release.NameSuffix }}",
    "# Source: foreign",
    '{{ "escaped\\nline" }}',
    "{{ `.Values.label` }}",
  ])
    assert.throws(() => helmExtensionsAction(line), Error, line);
});
test("Helm extension graph rejects undeclared unreachable mismatched and excessive dependency or value families before execution", () => {
  const variants = [
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[1]!.id = "root";
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[0]!.dependencies[1]!.alias = "first";
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[1]!.directory = "charts/other";
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[0]!.dependencies[0]!.target = "absent";
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[1]!.dependencies = [];
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[0]!.values.global = {};
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      Object.defineProperty(c.charts[0]!.values, "constructor", {
        value: "foreign",
        enumerable: true,
        configurable: true,
      });
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[0]!.values.first = "scalar";
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[2]!.templates = {};
    },
    (c: ReturnType<typeof helmExtensionsConfig>) => {
      c.charts[1]!.properties.first = { type: "boolean" };
      c.charts[1]!.dependencies[0]!.alias = "first";
    },
  ];
  for (const mutate of variants) {
    const c = helmExtensionsConfig();
    mutate(c);
    assert.throws(() => helmExtensionsRender(c));
  }
  const c = helmExtensionsConfig();
  c.charts[0]!.properties.source_name = { type: "string" };
  c.charts[0]!.values.source_name = "ordinary";
  assert.doesNotThrow(() => helmExtensionsRender(c));
});
