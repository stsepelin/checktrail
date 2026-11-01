import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inspectJvmDirectory } from "./consumer-witness-jvm.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const dataConsumerFamilies = Object.freeze(["hcl", "yaml"]);
export const dataConsumerRoles = Object.freeze([
  "grant:read",
  "grantToken",
  "grant2",
  "other",
  "grant",
  "grant:write",
  "g",
]);
export const dataConsumerClass = (family) =>
  family === "hcl" ? "terraform-finite-data" : "yaml-finite-recipe";
export const dataConsumerStages = (family) =>
  family === "hcl"
    ? [
        "hcl-init",
        ...dataConsumerRoles.flatMap((_, index) => [
          "hcl-plan-" + index,
          "hcl-show-" + index,
        ]),
      ]
    : ["consumer"];
export function normalizeDataInputs(value) {
  if (value.family !== "yaml") return value;
  const original = value.package.inventory;
  const inventory = {
    profile: original.profile,
    files: original.files,
    bytes: original.bytes,
    manifestSha256: original.manifestSha256,
  };
  return {
    profile: value.profile,
    family: value.family,
    tool: value.tool,
    package: {
      name: value.package.name,
      version: value.package.version,
      entry: value.package.entry,
      inventory,
    },
  };
}
export function inspectDataInputs(value, family) {
  assert.equal(value?.profile, "consumer-data-inputs-v1");
  assert.equal(value.family, family);
  assert.ok(dataConsumerFamilies.includes(family));
  assert.ok(
    Number.isSafeInteger(value.tool.bytes) &&
      value.tool.bytes > 0 &&
      value.tool.bytes <= 268435456 &&
      sha(value.tool.sha256),
  );
  if (family === "yaml") {
    assert.equal(value.package.name, "yaml");
    assert.equal(value.package.version, "2.9.1");
    inspectJvmDirectory(value.package.inventory, false, 2048);
    assert.ok(
      typeof value.package.entry === "string" &&
        value.package.entry.length <= 512 &&
        !/[\\\0:]/.test(value.package.entry) &&
        value.package.entry
          .split("/")
          .every((part) => part && part !== "." && part !== ".."),
    );
    assert.ok(
      value.package.inventory.files.some(
        (file) => file.path === value.package.entry,
      ),
    );
    assert.ok(
      value.package.inventory.files.some(
        (file) => file.path === "package.json",
      ),
    );
    assert.ok(sha(value.package.importUrlSha256));
  }
  return value;
}
export function dataConsumerArgs(stage) {
  if (stage === "hcl-init")
    return ["init", "-backend=false", "-input=false", "-no-color"];
  const plan = /^hcl-plan-([0-6])$/.exec(stage);
  if (plan)
    return [
      "plan",
      "-input=false",
      "-no-color",
      "-lock=false",
      "-var",
      "role=" + dataConsumerRoles[Number(plan[1])],
      "-out=original.plan",
    ];
  assert.match(stage, /^hcl-show-[0-6]$/);
  return ["show", "-json", "original.plan"];
}
const file = (value) => {
  if (value === null) return;
  assert.ok(
    value &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= 33554432 &&
      sha(value.sha256),
  );
};
export function inspectDataAttempt(value) {
  if (!dataConsumerFamilies.includes(value.family)) {
    assert.ok(value.data === undefined || value.data === null);
    return;
  }
  const data = value.data;
  assert.ok(data);
  inspectDataInputs(data.inputsBefore, value.family);
  assert.ok(data.inputsAfterSha256 === null || sha(data.inputsAfterSha256));
  if (value.family === "hcl") {
    assert.ok(dataConsumerStages("hcl").includes(value.stage));
    assert.deepEqual(data.args, dataConsumerArgs(value.stage));
    assert.equal(data.cwd, ".");
    file(data.planBefore);
    file(data.planAfter);
    if (data.moduleMap !== null) {
      assert.ok(
        typeof data.moduleMap.text === "string" &&
          Buffer.byteLength(data.moduleMap.text) <= 65536,
      );
      assert.equal(
        data.moduleMap.bytes,
        Buffer.byteLength(data.moduleMap.text),
      );
      assert.equal(data.moduleMap.sha256, hash(data.moduleMap.text));
    }
  }
}
export function requireDataAttemptBinding(witness, value) {
  if (!dataConsumerFamilies.includes(witness.family)) return;
  const data = value.data;
  assert.deepEqual(
    normalizeDataInputs(data.inputsBefore),
    normalizeDataInputs(witness.data.inputs),
  );
  assert.equal(
    data.inputsAfterSha256,
    hash(JSON.stringify(data.inputsBefore)),
    "Data parser/tool inputs changed during native command",
  );
  if (witness.family === "hcl") {
    assert.deepEqual(
      data.moduleMap,
      witness.data.moduleMap,
      "Terraform module manifest changed during data witness",
    );
    const index = Number(value.stage.at(-1));
    if (value.stage === "hcl-init") {
      assert.equal(data.planBefore, null);
      assert.equal(data.planAfter, null);
      assert.ok(data.moduleMap);
      const modules = JSON.parse(data.moduleMap.text).Modules;
      assert.ok(Array.isArray(modules));
      assert.ok(
        modules.some(
          (item) =>
            item.Key === "policy" &&
            item.Source === "./policy" &&
            item.Dir.replace(/\/$/, "") === "policy",
        ),
      );
    } else if (value.stage.startsWith("hcl-plan-")) {
      assert.deepEqual(data.planAfter, witness.data.plans[index]);
      assert.deepEqual(
        data.planBefore,
        index === 0 ? null : witness.data.plans[index - 1],
      );
    } else {
      assert.deepEqual(data.planBefore, witness.data.plans[index]);
      assert.deepEqual(
        data.planAfter,
        witness.data.plans[index],
        "Terraform plan bytes changed during show",
      );
      const output = JSON.parse(
        Buffer.from(value.output.stdout.base64, "base64").toString("utf8"),
      );
      assert.equal(output.terraform_version, "1.16.5");
      assert.equal(
        output.variables?.role?.value,
        dataConsumerRoles[index],
        "Native plan role differs from actual command role",
      );
      assert.equal(
        output.planned_values?.outputs?.result?.value,
        witness.data.results[index],
      );
      assert.ok(
        output.resource_changes === undefined ||
          (Array.isArray(output.resource_changes) &&
            output.resource_changes.length === 0),
        "Finite local data witness unexpectedly manages resources",
      );
    }
  }
}
export function inspectDataWitness(row) {
  const value = row.data;
  assert.ok(value);
  inspectDataInputs(value.inputs, row.family);
  assert.equal(value.evidenceClass, dataConsumerClass(row.family));
  assert.equal(value.fullImpactFallback, true);
  assert.equal(value.applicationSemanticsVerified, false);
  assert.equal(value.inputsAfterSha256, hash(JSON.stringify(value.inputs)));
  assert.deepEqual(value.roles, dataConsumerRoles);
  const expected =
    row.variant === "broken"
      ? [true, true, true, false, true, true, false]
      : row.variant === "fixed"
        ? [true, false, false, false, true, true, false]
        : [true, false, false, false, false, true, false];
  assert.deepEqual(
    value.results,
    expected,
    "Finite native data role results differ from original variant",
  );
  assert.equal(row.attempts.length, row.family === "hcl" ? 15 : 1);
  if (row.family === "hcl") {
    assert.ok(value.moduleMap);
    const map = value.moduleMap;
    assert.equal(map.bytes, Buffer.byteLength(map.text));
    assert.equal(map.sha256, hash(map.text));
    assert.equal(value.sourceBinding, "controller-filesystem-and-native-plan");
    assert.equal(value.plans.length, 7);
    for (const plan of value.plans) {
      file(plan);
      assert.ok(plan);
    }
  } else {
    const native = JSON.parse(
      Buffer.from(row.output.stdout.base64, "base64").toString("utf8"),
    );
    assert.deepEqual(native.roles, value.results);
    assert.deepEqual(native.aliases, {
      resultIsRules: true,
      mirrorIsRules: true,
    });
    assert.equal(native.moduleUrlSha256, value.inputs.package.importUrlSha256);
    assert.equal(value.sourceBinding, "native-data-source-byte-echo");
    assert.deepEqual(
      Object.keys(native.sources).sort(),
      row.before.map((file) => file.path).sort(),
    );
    for (const file of row.before) {
      const bytes = native.sources[file.path];
      assert.ok(
        Array.isArray(bytes) &&
          bytes.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
          ),
      );
      assert.equal(bytes.length, file.bytes);
      assert.equal(hash(Buffer.from(bytes)), file.sha256);
    }
  }
}
