import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { kubeNativeArgs } from "../src/kubeconform.js";
import {
  kustomizeEvidence,
  kustomizePacketSchema,
} from "../src/kustomize-evidence.js";
import {
  kustomizeResources,
  kustomizeSourceAddress,
} from "../src/kustomize.js";
import { mavenHash } from "../src/maven.js";
import type { Check, ProcessResult } from "../src/types.js";
import { originalKustomizeExtensionInvocation } from "./kustomize-extensions-fixture.js";
const receipt = process.env.CHECKTRAIL_KUSTOMIZE_GUARD_RECEIPT,
  options = {
    skip: receipt ? false : "Fresh native Kustomize guard receipt not selected",
  };
type Packet = ReturnType<typeof kustomizePacketSchema.parse>;
async function current() {
  const data = JSON.parse(await readFile(receipt!, "utf8")) as {
    root: string;
    check: Check;
    process: ProcessResult;
  };
  assert.equal(
    kustomizeEvidence(data.check, [data.process]).status,
    "passed",
    "Fresh complete native assembly remains reconciled",
  );
  return data;
}
for (const [label, relative, toolIndex] of [
  ["source", "overlay/strategic.yaml", -1],
  ["policy", "checktrail.kustomize.json", -1],
  ["schema", "tools/kubernetes/deployment-apps-v1.json", -1],
  ["kustomize tool", null, 0],
  ["kubeconform tool", null, 1],
] as const)
  test(
    "Kustomize guard checks current physical " + label + " bytes",
    options,
    async () => {
      const d = await current(),
        packet = kustomizePacketSchema.parse(JSON.parse(d.process.stdout)),
        file = relative
          ? path.join(d.root, relative)
          : packet.tools[toolIndex]!.entry,
        original = await readFile(file);
      try {
        const changed = Buffer.from(original);
        changed[0] = changed[0]! ^ 1;
        await writeFile(file, changed);
        assert.equal(
          kustomizeEvidence(d.check, [d.process]).status,
          "inconclusive",
          label + " byte drift",
        );
      } finally {
        await writeFile(file, original);
      }
      assert.equal(
        kustomizeEvidence(d.check, [d.process]).status,
        "passed",
        "Restored " + label,
      );
    },
  );
const faults: [
  string,
  (p: Packet, d: Awaited<ReturnType<typeof current>>) => void,
][] = [
  [
    "native schema inventory",
    (p) => {
      p.schemas.pop();
    },
  ],
  [
    "native schema pre-hash",
    (p) => {
      p.schemas[0]!.sha256 = "0".repeat(64);
    },
  ],
  [
    "native schema post-hash",
    (p) => {
      p.schemas[0]!.afterSha256 = "0".repeat(64);
    },
  ],
  [
    "native stdout hash",
    (p) => {
      p.receipts[2]!.stdoutSha256 = "0".repeat(64);
    },
  ],
  [
    "native stderr hash",
    (p) => {
      p.receipts[2]!.stderrSha256 = "0".repeat(64);
    },
  ],
  [
    "native command arguments",
    (p) => {
      p.receipts[2]!.args.push("--enable-alpha-plugins");
    },
  ],
  [
    "rendered document post-hash",
    (p) => {
      p.documents[0]!.afterSha256 = "0".repeat(64);
    },
  ],
  [
    "complete rendered resource participation",
    (p, d) => {
      const build = p.receipts[2]!,
        parsed = parseAllDocuments(build.stdout),
        removed = p.documents[0]!.file;
      assert.ok(parsed.length > 2 && parsed[1]!.range);
      build.stdout = build.stdout.slice(parsed[1]!.range![0]);
      build.stdoutSha256 = mavenHash(build.stdout);
      const original = p.documents.slice(1);
      p.documents = parseAllDocuments(build.stdout).map((doc, i) => {
        assert.ok(doc.range);
        const sha256 = mavenHash(
          build.stdout.slice(doc.range[0], doc.range[2]),
        );
        return {
          ...original[i]!,
          file: `documents/${i}.yaml`,
          sha256,
          afterSha256: sha256,
        };
      });
      const validation = p.receipts[3]!,
        native = JSON.parse(validation.stdout) as {
          resources: { filename: string }[];
          summary: { valid: number };
        };
      assert.equal(
        native.resources.filter((r) => r.filename === removed).length,
        1,
      );
      native.resources = native.resources
        .filter((r) => r.filename !== removed)
        .map((r) => ({
          ...r,
          filename: `documents/${Number(path.posix.basename(r.filename, ".yaml")) - 1}.yaml`,
        }));
      native.summary.valid--;
      validation.stdout = JSON.stringify(native);
      validation.stdoutSha256 = mavenHash(validation.stdout);
      const invocation = JSON.parse(
        d.check.commands[0]!.args[2]!,
      ) as ReturnType<typeof originalKustomizeExtensionInvocation>;
      validation.args = kubeNativeArgs(
        { ...invocation.config, manifests: p.documents.map((p) => p.file) },
        p.workspace,
        p.documents.length,
      );
    },
  ],
];
for (const [label, mutate] of faults)
  test("Kustomize guard checks " + label, options, async () => {
    const d = await current(),
      packet = kustomizePacketSchema.parse(JSON.parse(d.process.stdout));
    mutate(packet, d);
    assert.equal(
      kustomizeEvidence(d.check, [
        { ...d.process, stdout: JSON.stringify(packet) },
      ]).status,
      "inconclusive",
      label,
    );
  });
function editInput(
  invocation: ReturnType<typeof originalKustomizeExtensionInvocation>,
  file: string,
  edit: (text: string) => string,
) {
  const item = invocation.inputs.find((p) => p.path === file)!;
  item.text = edit(item.text);
  item.sha256 = mavenHash(item.text);
}
test("Kustomize guard checks declared patch participation", options, () => {
  const invocation = originalKustomizeExtensionInvocation();
  invocation.config.patches!.push("overlay/orphan.yaml");
  editInput(invocation, "checktrail.kustomize.json", () =>
    JSON.stringify(invocation.config),
  );
  const text = "- op: replace\n  path: /spec/replicas\n  value: 2\n";
  invocation.inputs.push({
    path: "overlay/orphan.yaml",
    text,
    sha256: mavenHash(text),
  });
  assert.throws(
    () => kustomizeResources(invocation),
    /Every declared assembly input/,
  );
});
for (const selector of ["JSON patch", "strategic patch", "replica"] as const)
  test(
    "Kustomize guard checks whole " + selector + " identifiers",
    options,
    () => {
      const invocation = originalKustomizeExtensionInvocation();
      if (selector === "JSON patch")
        editInput(invocation, "overlay/kustomization.yaml", (text) =>
          text.replace(
            "      name: original-worker",
            "      name: original-worker-extra",
          ),
        );
      else if (selector === "strategic patch")
        editInput(invocation, "overlay/strategic.yaml", (text) =>
          text.replace("name: original-worker", "name: original-worker-extra"),
        );
      else
        editInput(invocation, "overlay/kustomization.yaml", (text) =>
          text.replace(
            "  - name: original-worker",
            "  - name: original-worker-extra",
          ),
        );
      assert.throws(() => kustomizeResources(invocation), /match one/);
    },
  );
test("Kustomize guard checks raw policy identity", options, () => {
  const invocation = originalKustomizeExtensionInvocation();
  editInput(invocation, "checktrail.kustomize.json", () =>
    JSON.stringify({ ...invocation.config, root: "base" }),
  );
  assert.throws(
    () => kustomizeResources(invocation),
    /Raw declaration differs/,
  );
});
for (const field of ["file", "line"] as const)
  test("Kustomize guard checks physical patch source " + field, options, () => {
    const invocation = originalKustomizeExtensionInvocation(),
      deployment = kustomizeResources(invocation).find(
        (p) => p.value.kind === "Deployment",
      )!,
      address = kustomizeSourceAddress(
        deployment,
        "/spec/template/spec/containers/0/env/0/value",
      ),
      text = invocation.inputs.find(
        (p) => p.path === "overlay/strategic.yaml",
      )!.text;
    assert.equal(
      address[field],
      field === "file"
        ? "overlay/strategic.yaml"
        : text.slice(0, text.indexOf("value: original-extra")).split("\n")
            .length,
    );
  });
test("Kustomize guard checks whole image identifiers", options, () => {
  const invocation = originalKustomizeExtensionInvocation();
  editInput(
    invocation,
    "base/deployment.yaml",
    (text) =>
      text +
      "      initContainers:\n        - name: original-adjacent\n          image: registry.example.invalid/original-other:v1\n",
  );
  const deployment = kustomizeResources(invocation).find(
      (p) => p.value.kind === "Deployment",
    )!,
    pod = (
      deployment.value.spec!.template as {
        spec: { initContainers: { image: string }[] };
      }
    ).spec;
  assert.equal(
    pod.initContainers[0]!.image,
    "registry.example.invalid/original-other:v1",
  );
});
for (const feature of [
  "generated content hash",
  "generated ConfigMap references",
  "namespace transform",
  "name prefix",
  "name suffix",
  "image transform",
  "replica transform",
])
  test("Kustomize guard reconciles native " + feature, options, async () => {
    await current();
  });
