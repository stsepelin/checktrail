import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Check, ProcessResult } from "../src/types.js";
import { evaluate } from "../src/evidence.js";
const directory = process.env.CHECKTRAIL_JVM_GUARD_RECEIPTS;
const skip = directory
  ? false
  : "Actual native JVM guard receipts not selected";
type Packet = Record<string, unknown>;
const object = (input: unknown) => input as Packet;
const array = (input: unknown) => input as Packet[];
const extension = (packet: Packet) => object(packet.extensions);
const wrapper = (packet: Packet) => object(extension(packet).wrapper);
const controls: Record<string, (packet: Packet) => void> = {
  "wrapper-identity": (p) => {
    wrapper(p).originalSha256 = "0".repeat(64);
  },
  "generator-accounting": (p) => {
    array(extension(p).generated).push({
      ...array(extension(p).generated)[0],
      source: "generators/Foreign.java",
    });
  },
  "generator-input": (p) => {
    array(extension(p).generated)[0]!.sourceSha256 = "0".repeat(64);
  },
  "generated-output-accounting": (p) => {
    // Omit one real generated output consistently from downstream observations.
    // The remaining output still has a valid class contract and physical origin.
    const generated = array(extension(p).generated)[0]!;
    generated.outputs = array(generated.outputs).filter(
      (o) => o.className !== "policy.GeneratedMarker",
    );
    extension(p).generatedClasses = array(extension(p).generatedClasses).filter(
      (c) => c.className !== "policy.GeneratedMarker",
    );
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          if (
            typeof value[i] === "string" &&
            value[i].endsWith("/GeneratedMarker.java")
          )
            value.splice(i, 1);
          else walk(value[i]);
        }
      } else if (value && typeof value === "object")
        for (const next of Object.values(value)) walk(next);
    };
    walk(p);
  },
  "generated-class-contract": (p) => {
    array(array(extension(p).generated)[0]!.outputs)[0]!.className =
      "policy.Foreign";
    array(extension(p).generatedClasses)[0]!.className = "policy.Foreign";
  },
  "physical-class-accounting": (p) => {
    array(extension(p).generatedClasses).push({
      ...array(extension(p).generatedClasses)[0],
      path: "policy/src/main/java/policy/Foreign.java",
    });
  },
  "physical-class-origin": (p) => {
    array(extension(p).generatedClasses)[0]!.sourceFile = "Foreign.java";
  },
  "module-accounting": (p) => {
    array(extension(p).modules).push({
      ...array(extension(p).modules)[0],
      module: "foreign",
      name: "original.foreign",
    });
  },
  "module-contract": (p) => {
    array(extension(p).modules)[1]!.requires = ["java.base"];
  },
  "owned-distribution": (p) => {
    p.distribution = path.join(
      "/tmp/caller-owned",
      path.basename(String(p.distribution)),
    );
    array(p.events)[0]!.home = p.distribution;
  },
  "maven-compiler-inputs": (p) => {
    const module = array(p.modules).find((m) => m.path === "policy")!;
    object(module.inputs).compile = (
      object(module.inputs).compile as string[]
    ).filter((f) => !f.endsWith("/Rules.java"));
  },
  "gradle-source-inputs": (p) => {
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          if (typeof value[i] === "string" && value[i].endsWith("/Rules.java"))
            value.splice(i, 1);
          else walk(value[i]);
        }
      } else if (value && typeof value === "object")
        for (const next of Object.values(value)) walk(next);
    };
    walk(p.events);
  },
  "gradle-launcher-ancestry": (p) => {
    const init = array(p.events)[0]!;
    init.processId = Number(init.processId) + 100000;
    init.wrapperAncestors = [init.processId];
  },
};
for (const [id, mutate] of Object.entries(controls))
  test("actual JVM wrapper receipt rejects " + id, { skip }, async () => {
    const kinds = id.startsWith("maven-")
      ? ["maven"]
      : id.startsWith("gradle-")
        ? ["gradle"]
        : ["maven", "gradle"];
    for (const kind of kinds) {
      const saved = JSON.parse(
        await readFile(path.join(directory!, kind + ".json"), "utf8"),
      ) as { root: string; plan: Check; process: ProcessResult };
      assert.equal(
        evaluate(saved.plan, [saved.process], saved.root).status,
        "passed",
        "Actual native control must start from reconciled evidence",
      );
      const packet = JSON.parse(saved.process.stdout) as Packet;
      mutate(packet);
      assert.equal(
        evaluate(
          saved.plan,
          [{ ...saved.process, stdout: JSON.stringify(packet) }],
          saved.root,
        ).status,
        "inconclusive",
        "Altered native " + id + " evidence must fail its guard",
      );
    }
  });
