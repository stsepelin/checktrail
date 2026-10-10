import assert from "node:assert/strict";
import { test } from "node:test";
import {
  scalaExtensionsSchema,
  validateScalaExtensionScope,
  scalaScriptSource,
} from "../src/scala-extensions.js";
const scope = [
  "producer/Macros.scala",
  "consumer/Consumer.scala",
  "producer/Producer.java",
  "consumer/compile only.sc",
  "generators/BuildScalaGenerator.java",
];
const declaration = {
  profile: "linux-arm64-scala3-mixed-generated-script-v1",
  javaSources: ["producer/Producer.java"],
  scripts: [
    { file: "consumer/compile only.sc", className: "scripts.Original" },
  ],
  generators: [
    {
      source: "generators/BuildScalaGenerator.java",
      className: "gen.BuildScalaGenerator",
      outputs: [
        {
          file: "src/main/scala/policy/Rules.scala",
          className: "policy.Rules",
        },
      ],
    },
  ],
  stages: [
    { id: "producer", sources: ["producer/Macros.scala"] },
    {
      id: "consumer",
      sources: [
        "consumer/Consumer.scala",
        "consumer/compile only.sc",
        "src/main/scala/policy/Rules.scala",
      ],
    },
  ],
};
test("mixed Scala declarations account for all ordered stages and preserve compile-only script bytes without running code", () => {
  const ext = scalaExtensionsSchema.parse(declaration);
  assert.deepEqual(validateScalaExtensionScope(ext, scope), {
    generators: ["generators/BuildScalaGenerator.java"],
    generated: ["src/main/scala/policy/Rules.scala"],
    compilerSources: [
      "producer/Macros.scala",
      "consumer/Consumer.scala",
      "consumer/compile only.sc",
      "src/main/scala/policy/Rules.scala",
    ],
  });
  const original = Buffer.from(
      'val value:Int=4\r\nthrow new Exception("must never initialize")\r\n',
    ),
    wrapped = scalaScriptSource(ext.scripts[0]!, original);
  assert.equal(wrapped.file, "scripts/scripts/Original.scala");
  assert.equal(wrapped.lineOffset, 2);
  assert.equal(
    wrapped.bytes.toString(),
    "package `scripts`\nobject `Original` {\n" + original.toString() + "}\n",
  );
  assert.equal(
    original.toString(),
    'val value:Int=4\r\nthrow new Exception("must never initialize")\r\n',
  );
});
test("mixed Scala declarations reject omitted repeated and foreign source roles and invalid ordered cohort inventories", () => {
  const ext = scalaExtensionsSchema.parse(declaration);
  for (const patch of [
    { javaSources: [] },
    { javaSources: [...ext.javaSources, ...ext.javaSources] },
    { scripts: [] },
    { scripts: [...ext.scripts, ...ext.scripts] },
    { generators: [...ext.generators, ...ext.generators] },
    { stages: [ext.stages[0]!] },
    { stages: [...ext.stages, ...ext.stages] },
    {
      stages: [
        {
          id: "all",
          sources: [...ext.stages.flatMap((s) => s.sources), "foreign.scala"],
        },
      ],
    },
    {
      generators: [
        {
          ...ext.generators[0]!,
          outputs: [
            {
              file: "src/main/scala/policy/Rules.scala",
              className: "policy.Foreign",
            },
          ],
        },
      ],
    },
  ])
    assert.throws(() =>
      validateScalaExtensionScope(
        scalaExtensionsSchema.parse({ ...ext, ...patch }),
        scope,
      ),
    );
  for (const patch of [
    { profile: "execute-scripts" },
    { executeScripts: true },
    { plugins: ["arbitrary.jar"] },
    { scripts: [{ file: "../foreign.sc", className: "Outside" }] },
  ])
    assert.equal(
      scalaExtensionsSchema.safeParse({ ...declaration, ...patch }).success,
      false,
    );
  assert.throws(() =>
    validateScalaExtensionScope(ext, [...scope, "foreign.kt"]),
  );
  for (const text of [
    "#!/usr/bin/env scala\nval x=1",
    "//> using dep example:latest\nval x=1",
    "package another\nval x=1",
  ])
    assert.throws(
      () => scalaScriptSource(ext.scripts[0]!, Buffer.from(text)),
      /separate script profile/,
    );
  assert.throws(
    () => scalaScriptSource(ext.scripts[0]!, Buffer.from([0xff])),
    /encoded data/,
  );
  const literal =
    'val payload = """\n//> using dep ignored:latest\npackage data\n"""\n/* //> ignored /* nested */ package ignored */\n';
  assert.ok(
    scalaScriptSource(ext.scripts[0]!, Buffer.from(literal))
      .bytes.toString()
      .includes(literal),
  );
  assert.equal(
    scalaScriptSource(
      { file: "keyword.sc", className: "type.object" },
      Buffer.from("val x=1"),
    ).bytes.toString(),
    "package `type`\nobject `object` {\nval x=1\n}\n",
  );
  const local = scalaScriptSource(
    { file: "plain.sc", className: "Plain" },
    Buffer.from("val x=1"),
  );
  assert.equal(local.lineOffset, 1);
  assert.equal(local.bytes.toString(), "object `Plain` {\nval x=1\n}\n");
});
