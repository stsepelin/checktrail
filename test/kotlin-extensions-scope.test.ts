import assert from "node:assert/strict";
import { test } from "node:test";
import {
  kotlinExtensionsSchema,
  validateKotlinExtensionScope,
} from "../src/kotlin-extensions.js";
const scope = [
  "producer/Producer.java",
  "consumer/Consumer.kt",
  "consumer/compile only.kts",
  "generators/BuildKotlinGenerator.java",
];
const original = {
  profile: "linux-arm64-mixed-generated-script-v1",
  javaSources: ["producer/Producer.java"],
  scripts: ["consumer/compile only.kts"],
  generators: [
    {
      source: "generators/BuildKotlinGenerator.java",
      className: "gen.BuildKotlinGenerator",
      outputs: [
        { file: "src/main/kotlin/policy/Rules.kt", className: "policy.Rules" },
      ],
    },
  ],
};
test("mixed Kotlin declarations account for every source role without executing script or generator content", () => {
  const selected = kotlinExtensionsSchema.parse(original);
  assert.deepEqual(validateKotlinExtensionScope(selected, scope), {
    generators: ["generators/BuildKotlinGenerator.java"],
    generated: ["src/main/kotlin/policy/Rules.kt"],
  });
  assert.deepEqual(
    validateKotlinExtensionScope({ ...selected, scripts: [], generators: [] }, [
      "producer/Producer.java",
      "consumer/Consumer.kt",
    ]).generated,
    [],
  );
});
test("mixed Kotlin declarations reject omissions duplicates collisions wrong class paths and unsupported descriptors", () => {
  for (const patch of [
    { javaSources: [] },
    { javaSources: ["producer/Producer.java", "producer/Producer.java"] },
    { scripts: [] },
    { scripts: ["consumer/compile only.kts", "consumer/compile only.kts"] },
    { generators: [...original.generators, ...original.generators] },
    { generators: [{ ...original.generators[0], className: "gen.Foreign" }] },
    {
      generators: [
        {
          ...original.generators[0],
          outputs: [
            { file: "consumer/Consumer.kt", className: "consumer.Consumer" },
          ],
        },
      ],
    },
    {
      generators: [
        {
          ...original.generators[0],
          outputs: [
            {
              file: "src/main/kotlin/policy/Rules.kt",
              className: "policy.Foreign",
            },
          ],
        },
      ],
    },
  ])
    assert.throws(() =>
      validateKotlinExtensionScope(
        kotlinExtensionsSchema.parse({ ...original, ...patch }),
        scope,
      ),
    );
  const module = kotlinExtensionsSchema.parse({
    ...original,
    javaSources: ["module-info.java"],
  });
  assert.throws(
    () =>
      validateKotlinExtensionScope(module, [
        "module-info.java",
        ...scope.slice(1),
      ]),
    /Declare every/,
  );
  for (const patch of [
    { profile: "execute-scripts" },
    { scripts: ["../outside.kts"] },
    { executeScripts: true },
    { plugins: ["arbitrary.jar"] },
  ])
    assert.equal(
      kotlinExtensionsSchema.safeParse({ ...original, ...patch }).success,
      false,
    );
});
