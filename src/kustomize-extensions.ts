import path from "node:path";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { parseAllDocuments, visit } from "yaml";
import { mavenHash } from "./maven.js";
import { verifyKubernetesExtensionTool } from "./kubernetes-extensions.js";
import { kubeBinarySha256 } from "./kubeconform.js";
import {
  kustomizeRequire as require,
  kustomizeCanonical,
  kustomizeBinarySha256,
  type KustomizeInvocation,
  type KustomizeResource,
} from "./kustomize.js";
export const kustomizeExtensionProfile = "local-transforms-v1";
type Address = { file: string; line: number };
type Trace = {
  address: Address;
  scalar?: unknown;
  children?: Map<string, Trace> | Trace[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);
// Select repository identities; tags/digests belong to their separate rewrite fields.
const imageRepository = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
    "Explicit image repository identity required",
  );
const declaration = z.strictObject({
  apiVersion: z.literal("kustomize.config.k8s.io/v1beta1"),
  kind: z.literal("Kustomization"),
  resources: z.array(z.string().min(1).max(256)).min(1).max(32),
  namePrefix: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]*$/)
    .optional(),
  nameSuffix: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]*$/)
    .optional(),
  namespace: name.optional(),
  replicas: z
    .array(
      z.strictObject({
        name,
        count: z.number().int().nonnegative().max(1000000),
      }),
    )
    .max(32)
    .optional(),
  images: z
    .array(
      z.strictObject({
        name: imageRepository,
        newName: imageRepository.optional(),
        newTag: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_.-]+$/)
          .optional(),
        digest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .max(32)
    .optional(),
  patches: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(256),
        target: z
          .strictObject({
            group: z.enum(["", "apps"]).optional(),
            version: z.literal("v1"),
            kind: z.enum(["Deployment", "ConfigMap", "Service"]),
            name,
            namespace: name.optional(),
          })
          .optional(),
      }),
    )
    .max(16)
    .optional(),
  configMapGenerator: z
    .array(
      z.strictObject({
        name,
        literals: z.array(z.string().min(3).max(1024)).min(1).max(32),
        options: z
          .strictObject({ disableNameSuffixHash: z.boolean() })
          .optional(),
      }),
    )
    .max(16)
    .optional(),
  generatorOptions: z
    .strictObject({ disableNameSuffixHash: z.boolean() })
    .optional(),
  buildMetadata: z.tuple([z.literal("originAnnotations")]).optional(),
});
const operation = z.strictObject({
  op: z.enum(["add", "replace", "remove", "test", "copy", "move"]),
  path: z.string().min(1).max(1024),
  from: z.string().min(1).max(1024).optional(),
  value: z.unknown().optional(),
});
const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
function tokens(pointer: string) {
  require(pointer.startsWith("/") &&
    !/~(?![01])/.test(pointer), "Canonical JSON patch pointer required");
  const result = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  require(result.length <= 16, "Patch pointer exceeds bound");
  return result;
}
function child(t: Trace, key: string) {
  if (t.children instanceof Map) {
    const v = t.children.get(key);
    require(v, "Patch field is absent");
    return v;
  }
  require(Array.isArray(t.children) &&
    /^(?:0|[1-9]\d*)$/.test(key), "Canonical patch array index required");
  const v = t.children[Number(key)];
  require(v, "Patch index is absent");
  return v;
}
function lookup(t: Trace, keys: string[]): Trace {
  for (const k of keys) t = child(t, k);
  return t;
}
function value(t: Trace): unknown {
  if (t.children instanceof Map)
    return Object.fromEntries([...t.children].map(([k, v]) => [k, value(v)]));
  if (Array.isArray(t.children)) return t.children.map(value);
  return t.scalar;
}
function clone(t: Trace): Trace {
  return t.children instanceof Map
    ? {
        address: t.address,
        children: new Map([...t.children].map(([k, v]) => [k, clone(v)])),
      }
    : Array.isArray(t.children)
      ? { address: t.address, children: t.children.map(clone) }
      : { address: t.address, scalar: t.scalar };
}
function trace(
  v: unknown,
  address: (keys: (string | number)[]) => Address,
  keys: (string | number)[] = [],
): Trace {
  if (Array.isArray(v))
    return {
      address: address(keys),
      children: v.map((x, i) => trace(x, address, [...keys, i])),
    };
  if (object(v))
    return {
      address: address(keys),
      children: new Map(
        Object.entries(v).map(([k, x]) => [k, trace(x, address, [...keys, k])]),
      ),
    };
  require(v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" &&
      Number.isFinite(v)), "Finite JSON value required");
  return { address: address(keys), scalar: v };
}
function write(parent: Trace, key: string, t: Trace, add: boolean) {
  if (parent.children instanceof Map) {
    require(add || parent.children.has(key), "Patch replace target is absent");
    parent.children.set(key, t);
    return;
  }
  require(Array.isArray(parent.children), "Patch parent is not a collection");
  const i =
    key === "-" && add
      ? parent.children.length
      : /^(?:0|[1-9]\d*)$/.test(key)
        ? Number(key)
        : -1;
  require(i >= 0 &&
    i <=
      (add
        ? parent.children.length
        : parent.children.length - 1), "Patch index is outside array");
  if (add) parent.children.splice(i, 0, t);
  else parent.children[i] = t;
}
function remove(parent: Trace, key: string, address: Address) {
  child(parent, key);
  if (parent.children instanceof Map) parent.children.delete(key);
  else (parent.children as Trace[]).splice(Number(key), 1);
  parent.address = address;
}
function merge(base: Trace, patch: Trace, pointer: string): Trace | undefined {
  if (patch.children instanceof Map) {
    const directive = patch.children.get("$patch"),
      mode = directive ? value(directive) : "merge";
    require(["merge", "replace", "delete"].includes(
      String(mode),
    ), "Unsupported strategic directive");
    for (const key of patch.children.keys())
      require(!key.startsWith("$") ||
        key === "$patch", "Unsupported strategic ordering directive");
    if (mode === "delete") return undefined;
    const clean = clone(patch);
    (clean.children as Map<string, Trace>).delete("$patch");
    if (mode === "replace" || !(base.children instanceof Map)) return clean;
    for (const [key, t] of clean.children as Map<string, Trace>) {
      if (t.scalar === null && !t.children) {
        base.children.delete(key);
        base.address = t.address;
        continue;
      }
      const prior = base.children.get(key),
        next = prior ? merge(prior, t, pointer + "/" + escape(key)) : clone(t);
      if (next) base.children.set(key, next);
      else {
        base.children.delete(key);
        base.address = t.address;
      }
    }
    return base;
  }
  if (Array.isArray(patch.children)) {
    const first = patch.children[0];
    if (first?.children instanceof Map && first.children.has("$patch")) {
      require(value(child(first, "$patch")) === "replace" &&
        first.children.size === 1, "Unsupported array directive");
      return {
        address: patch.address,
        children: patch.children.slice(1).map(clone),
      };
    }
    const key =
      /\/(?:containers|initContainers|volumes|env|imagePullSecrets)$/.test(
        pointer,
      )
        ? "name"
        : /\/volumeMounts$/.test(pointer)
          ? "mountPath"
          : /\/containers\/\d+\/ports$/.test(pointer)
            ? "containerPort"
            : pointer === "/spec/ports"
              ? "port"
              : undefined;
    if (!key || !Array.isArray(base.children)) return clone(patch);
    const pending = base.children.slice(),
      result: Trace[] = [],
      seen = new Set<string>();
    for (const t of patch.children) {
      const id = kustomizeCanonical(value(child(t, key)));
      require(!seen.has(id), "Duplicate strategic merge key");
      seen.add(id);
      const found = pending
        .map((v, i) =>
          kustomizeCanonical(value(child(v, key))) === id ? i : -1,
        )
        .filter((i) => i >= 0);
      require(found.length <= 1, "Ambiguous strategic merge key");
      const prior = found.length ? pending.splice(found[0]!, 1)[0] : undefined;
      const next = merge(
        prior ?? { address: t.address, children: new Map() },
        clone(t),
        pointer + "/" + result.length,
      );
      if (next) result.push(next);
    }
    return { address: patch.address, children: [...result, ...pending] };
  }
  return clone(patch);
}
function patchJson(
  root: Trace,
  operations: unknown,
  address: (keys: (string | number)[]) => Address,
) {
  const rows = z.array(operation).min(1).max(64).parse(operations);
  for (const [i, row] of rows.entries()) {
    const keys = tokens(row.path),
      parent = lookup(root, keys.slice(0, -1)),
      key = keys.at(-1)!,
      at = address([i, "path"]);
    if (["copy", "move"].includes(row.op)) {
      require(row.from !== undefined &&
        !Object.hasOwn(row, "value"), "Patch copy/move requires only from");
      const from = tokens(row.from);
      require(row.op !== "move" ||
        !row.path.startsWith(row.from + "/"), "Cannot move into own child");
      const source = clone(lookup(root, from));
      if (row.op === "move")
        remove(lookup(root, from.slice(0, -1)), from.at(-1)!, at);
      write(lookup(root, keys.slice(0, -1)), key, source, true);
    } else if (row.op === "remove") {
      require(row.from === undefined &&
        !Object.hasOwn(row, "value"), "Remove has no value/from");
      remove(parent, key, at);
    } else {
      require(row.from === undefined &&
        Object.hasOwn(row, "value"), "Patch value required");
      const t = trace(row.value, (k) => address([i, "value", ...k]));
      if (row.op === "test")
        require(kustomizeCanonical(value(child(parent, key))) ===
          kustomizeCanonical(row.value), "JSON patch test differs");
      else write(parent, key, t, row.op === "add");
    }
  }
}
const scalar = (t: Trace, keys: string[]) => value(lookup(t, keys));
function set(t: Trace, keys: string[], v: unknown, address: Address) {
  let parent = t;
  for (const key of keys.slice(0, -1)) {
    require(parent.children instanceof Map, "Transform parent differs");
    if (!parent.children.has(key))
      parent.children.set(key, { address, children: new Map() });
    parent = child(parent, key);
  }
  write(
    parent,
    keys.at(-1)!,
    trace(v, () => address),
    true,
  );
}
function goJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(goJson).join(",") + "]";
  if (object(v))
    return (
      "{" +
      Object.keys(v)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map((k) => goJson(k) + ":" + goJson(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v).replace(
    /[<>&\u2028\u2029]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export function kustomizeGeneratedConfigMapHash(
  data: unknown,
  binaryData?: unknown,
) {
  // Exact pinned 5.8.2 native observation: Lookup("metadata/name") is absent.
  const payload: Record<string, unknown> = {
    data: data ?? "",
    kind: "ConfigMap",
    name: "",
  };
  if (object(binaryData)) payload.binaryData = binaryData;
  const hex = mavenHash(goJson(payload)).slice(0, 10),
    substitutions: Record<string, string> = {
      "0": "g",
      "1": "h",
      "3": "k",
      a: "m",
      e: "t",
    };
  return [...hex].map((c) => substitutions[c] ?? c).join("");
}
export async function verifyKustomizeExtensionTools() {
  await verifyKubernetesExtensionTool(kubeBinarySha256);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory, "kustomize");
    try {
      await access(file, constants.X_OK);
    } catch {
      continue;
    }
    const info = await lstat(file);
    require(info.isFile() &&
      !info.isSymbolicLink() &&
      info.size <= 128 * 1048576 &&
      (await realpath(file)) ===
        file, "Select a canonical bounded native renderer");
    const bytes = await readFile(file);
    require(bytes.length === info.size &&
      mavenHash(bytes) === kustomizeBinarySha256, "Renderer pin differs");
    return;
  }
  throw Error("Prepare pinned renderer");
}
export function extendedKustomizeResources(
  invocation: KustomizeInvocation,
): KustomizeResource[] {
  const { config, inputs } = invocation,
    scope = [
      ...config.kustomizations,
      ...config.resources,
      ...(config.patches ?? []),
    ];
  require(config.assemblyProfile === kustomizeExtensionProfile &&
    new Set(scope).size === scope.length &&
    inputs.length === scope.length + 1 &&
    new Set(inputs.map((i) => i.path)).size ===
      inputs.length, "Extended input closure differs");
  require(scope.every(
    (f) =>
      !["schemas", "documents", "home", "tmp", "data"].includes(
        f.split("/")[0]!,
      ),
  ), "Scratch names reserved");
  require(inputs.every(
    (i) => mavenHash(i.text) === i.sha256,
  ), "Input pin differs");
  const policy = inputs.find((i) => i.path === "checktrail.kustomize.json");
  require(policy &&
    kustomizeCanonical(JSON.parse(policy.text)) ===
      kustomizeCanonical(config), "Raw declaration differs");
  type Model = {
    source: KustomizeResource["source"];
    root: Trace;
    aliases: Set<string>;
    generator?: { disableHash: boolean; origin: string };
  };
  const visited = new Set<string>(),
    used = new Set<string>(),
    patches = new Set<string>(),
    active = new Set<string>();
  const input = (file: string) => {
    const item = inputs.find((i) => i.path === file);
    require(item, "Input missing");
    return item;
  };
  const parse = (file: string) => {
    const original = input(file),
      docs = parseAllDocuments(original.text, {
        strict: true,
        uniqueKeys: true,
        prettyErrors: false,
      });
    require(docs.length === 1 &&
      docs[0]!.contents &&
      docs[0]!.range &&
      !docs[0]!.errors.length &&
      !docs[0]!.warnings.length, "Unambiguous single YAML/JSON required");
    const doc = docs[0]!;
    visit(doc, {
      Alias() {
        throw Error("Aliases unsupported");
      },
      Pair(_key, pair) {
        require(String(pair.key) !== "<<", "Merge keys unsupported");
      },
    });
    const data = doc.toJS({ maxAliasCount: 0 }) as unknown;
    kustomizeCanonical(data);
    const address = (keys: (string | number)[]) => {
      const node = keys.length ? doc.getIn(keys, true) : doc.contents;
      const offset =
        node &&
        typeof node === "object" &&
        "range" in node &&
        Array.isArray(node.range)
          ? Number(node.range[0])
          : doc.range![0];
      return { file, line: original.text.slice(0, offset).split("\n").length };
    };
    return { original, doc, data, address };
  };
  const local = (file: string, relative: string) => {
    require(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(
      relative,
    ), "Patch paths must stay within their kustomization");
    return path.posix.join(path.posix.dirname(file), relative);
  };
  const build = (file: string, depth: number): Model[] => {
    require(depth <= 8 &&
      !visited.has(file) &&
      !active.has(file) &&
      file.endsWith(
        "/kustomization.yaml",
      ), "Repeated/cyclic/noncanonical assembly");
    visited.add(file);
    active.add(file);
    const p = parse(file),
      d = declaration.parse(p.data),
      models: Model[] = [];
    if (file === config.root + "/kustomization.yaml")
      require(d.buildMetadata?.[0] ===
        "originAnnotations", "Native origins required");
    for (const relative of d.resources) {
      require(/^(?:\.\.\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(
        relative,
      ), "Local resource required");
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), relative),
      );
      require(!target.startsWith("../") &&
        !path.posix.isAbsolute(target), "Resource escapes project");
      const nested = target + "/kustomization.yaml";
      if (config.kustomizations.includes(nested)) {
        models.push(...build(nested, depth + 1));
        continue;
      }
      require(config.resources.includes(target) &&
        !used.has(target) &&
        /\.ya?ml$/.test(target), "Foreign/repeated resource");
      used.add(target);
      const source = parse(target),
        v = z
          .object({
            apiVersion: z.string(),
            kind: z.string(),
            metadata: z
              .object({
                name,
                namespace: z.string().optional(),
                annotations: z.record(z.string(), z.string()).optional(),
              })
              .passthrough(),
          })
          .passthrough()
          .parse(source.data);
      require((v.kind === "Deployment" && v.apiVersion === "apps/v1") ||
        (["ConfigMap", "Service"].includes(v.kind) &&
          v.apiVersion === "v1"), "Resource kind outside transform profile");
      require(!Object.hasOwn(
        v.metadata.annotations ?? {},
        "config.kubernetes.io/origin",
      ), "Source cannot claim origin");
      const text = source.original.text.slice(
        source.doc.range![0],
        source.doc.range![2],
      );
      models.push({
        source: {
          file: target,
          index: 0,
          text,
          sha256: mavenHash(text),
          kind: v.kind,
          version: v.apiVersion,
          name: v.metadata.name,
          line: source.address([]).line,
        },
        root: trace(v, source.address),
        aliases: new Set([v.metadata.name]),
      });
    }
    for (const [i, g] of (d.configMapGenerator ?? []).entries()) {
      const data: Record<string, string> = Object.create(null) as Record<
        string,
        string
      >;
      for (const [j, literal] of g.literals.entries()) {
        const equal = literal.indexOf("="),
          key = literal.slice(0, equal);
        require(equal > 0 &&
          /^[A-Za-z0-9_.-]+$/.test(key) &&
          !Object.hasOwn(data, key), "Unique literal key required");
        data[key] = literal.slice(equal + 1);
        require(!/[\r\n\0]/.test(
          data[key]!,
        ), "Single-line generator literal required");
        void j;
      }
      const root = trace(
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: g.name },
          data,
        },
        () => p.address(["configMapGenerator", i]),
      );
      for (const [j, literal] of g.literals.entries())
        set(
          root,
          ["data", literal.slice(0, literal.indexOf("="))],
          literal.slice(literal.indexOf("=") + 1),
          p.address(["configMapGenerator", i, "literals", j]),
        );
      set(
        root,
        ["metadata", "name"],
        g.name,
        p.address(["configMapGenerator", i, "name"]),
      );
      models.push({
        source: {
          file,
          index: i,
          text: p.original.text,
          sha256: mavenHash(p.original.text),
          kind: "ConfigMap",
          version: "v1",
          name: g.name,
          line: p.address(["configMapGenerator", i]).line,
        },
        root,
        aliases: new Set([g.name]),
        generator: {
          disableHash:
            g.options?.disableNameSuffixHash === true ||
            d.generatorOptions?.disableNameSuffixHash === true,
          origin:
            "configuredIn: " +
            path.posix.relative(config.root, file) +
            "\nconfiguredBy:\n  apiVersion: builtin\n  kind: ConfigMapGenerator\n",
        },
      });
    }
    for (const entry of d.patches ?? []) {
      const target = local(file, entry.path);
      require(config.patches?.includes(target) &&
        !patches.has(target), "Foreign/repeated patch");
      patches.add(target);
      const q = parse(target);
      if (Array.isArray(q.data)) {
        require(entry.target, "JSON patch target required");
        const selector = entry.target,
          selected = models.filter(
            (m) =>
              scalar(m.root, ["kind"]) === selector.kind &&
              scalar(m.root, ["apiVersion"]) ===
                (selector.group ? selector.group + "/" : "") +
                  selector.version &&
              (m.aliases.has(selector.name) ||
                scalar(m.root, ["metadata", "name"]) === selector.name) &&
              (selector.namespace === undefined ||
                ((value(child(m.root, "metadata")) as Record<string, unknown>)
                  .namespace ?? "") === selector.namespace),
          );
        require(selected.length ===
          1, "Patch selector must match one resource");
        patchJson(selected[0]!.root, q.data, q.address);
      } else {
        require(!entry.target &&
          object(q.data), "Strategic patch uses its exact resource identity");
        const patchValue = q.data;
        const metadata = patchValue.metadata;
        require(object(metadata) &&
          typeof metadata.name ===
            "string", "Strategic patch identity missing");
        const selected = models.filter(
          (m) =>
            scalar(m.root, ["kind"]) === patchValue.kind &&
            scalar(m.root, ["apiVersion"]) === patchValue.apiVersion &&
            m.aliases.has(String(metadata.name)),
        );
        require(selected.length ===
          1, "Strategic identity must match one resource");
        const next = merge(selected[0]!.root, trace(q.data, q.address), "");
        require(next, "Whole-resource deletion requires another profile");
        selected[0]!.root = next;
      }
    }
    for (const [i, replica] of (d.replicas ?? []).entries()) {
      const selected = models.filter(
        (m) =>
          scalar(m.root, ["kind"]) === "Deployment" &&
          m.aliases.has(replica.name),
      );
      require(selected.length ===
        1, "Replica selector must match one Deployment");
      set(
        selected[0]!.root,
        ["spec", "replicas"],
        replica.count,
        p.address(["replicas", i, "count"]),
      );
    }
    for (const m of models) {
      const prior = String(scalar(m.root, ["metadata", "name"])),
        next = (d.namePrefix ?? "") + prior + (d.nameSuffix ?? "");
      if (next !== prior) {
        set(
          m.root,
          ["metadata", "name"],
          next,
          p.address([d.nameSuffix ? "nameSuffix" : "namePrefix"]),
        );
        m.aliases.add(next);
      }
      if (d.namespace)
        set(
          m.root,
          ["metadata", "namespace"],
          d.namespace,
          p.address(["namespace"]),
        );
    }
    require(new Set((d.images ?? []).map((i) => i.name)).size ===
      (d.images ?? []).length, "Duplicate image selector");
    for (const [i, image] of (d.images ?? []).entries()) {
      require(!(image.digest && image.newTag) &&
        !!(
          image.newName ||
          image.newTag ||
          image.digest
        ), "One explicit image rewrite required");
      for (const m of models.filter(
        (m) => scalar(m.root, ["kind"]) === "Deployment",
      )) {
        for (const list of ["containers", "initContainers"]) {
          let items: Trace;
          try {
            items = lookup(m.root, ["spec", "template", "spec", list]);
          } catch {
            continue;
          }
          require(Array.isArray(items.children), "Pod container list differs");
          for (const c of items.children) {
            const current = String(scalar(c, ["image"])),
              withoutDigest = current.split("@")[0]!,
              lastSlash = withoutDigest.lastIndexOf("/"),
              lastColon = withoutDigest.lastIndexOf(":"),
              base =
                lastColon > lastSlash
                  ? withoutDigest.slice(0, lastColon)
                  : withoutDigest;
            if (base !== image.name) continue;
            const suffix = image.digest
              ? "@" + image.digest
              : image.newTag
                ? ":" + image.newTag
                : current.slice(base.length);
            set(
              c,
              ["image"],
              (image.newName ?? base) + suffix,
              p.address([
                "images",
                i,
                image.digest ? "digest" : image.newTag ? "newTag" : "newName",
              ]),
            );
          }
        }
      }
    }
    active.delete(file);
    require(models.length <= 32, "Rendered resource limit exceeded");
    return models;
  };
  const models = build(config.root + "/kustomization.yaml", 0);
  require(visited.size === config.kustomizations.length &&
    used.size === config.resources.length &&
    patches.size ===
      (config.patches ?? [])
        .length, "Every declared assembly input must participate");
  for (const m of models) {
    if (m.generator && !m.generator.disableHash) {
      const v = value(m.root) as Record<string, unknown>;
      require(Object.keys(v).every((k) =>
        ["apiVersion", "kind", "metadata", "data", "binaryData"].includes(k),
      ), "Generated shape outside hash contract");
      const old = String(scalar(m.root, ["metadata", "name"]));
      set(
        m.root,
        ["metadata", "name"],
        old + "-" + kustomizeGeneratedConfigMapHash(v.data, v.binaryData),
        child(child(m.root, "metadata"), "name").address,
      );
    }
  }
  const maps = models.filter((m) => scalar(m.root, ["kind"]) === "ConfigMap");
  for (const m of models.filter(
    (m) => scalar(m.root, ["kind"]) === "Deployment",
  )) {
    const pod = lookup(m.root, ["spec", "template", "spec"]),
      namespace =
        (value(child(m.root, "metadata")) as Record<string, unknown>)
          .namespace ?? "";
    const rewrite = (node: Trace, keys: string[]) => {
      let leaf: Trace;
      try {
        leaf = lookup(node, keys);
      } catch {
        return;
      }
      const current = value(leaf);
      require(typeof current ===
        "string", "ConfigMap reference must be a string");
      const found = maps.filter(
        (g) =>
          g.aliases.has(current) &&
          ((value(child(g.root, "metadata")) as Record<string, unknown>)
            .namespace ?? "") === namespace,
      );
      require(found.length <= 1, "Ambiguous ConfigMap reference");
      if (found.length)
        leaf.scalar = scalar(found[0]!.root, ["metadata", "name"]);
    };
    for (const list of ["containers", "initContainers"]) {
      let items: Trace;
      try {
        items = child(pod, list);
      } catch {
        continue;
      }
      require(Array.isArray(items.children), "Container list differs");
      for (const c of items.children) {
        for (const [field, keys] of [
          ["envFrom", ["configMapRef", "name"]],
          ["env", ["valueFrom", "configMapKeyRef", "name"]],
        ] as const) {
          let entries: Trace;
          try {
            entries = child(c, field);
          } catch {
            continue;
          }
          require(Array.isArray(entries.children), "Environment list differs");
          for (const e of entries.children) rewrite(e, [...keys]);
        }
      }
    }
    let volumes: Trace | undefined;
    try {
      volumes = child(pod, "volumes");
    } catch {
      /* Absent volume field. */
    }
    if (volumes) {
      require(Array.isArray(volumes.children), "Volume list differs");
      for (const v of volumes.children) rewrite(v, ["configMap", "name"]);
    }
  }
  const result: KustomizeResource[] = models.map((m) => {
    set(
      m.root,
      ["metadata", "annotations", "config.kubernetes.io/origin"],
      m.generator?.origin ??
        "path: " + path.posix.relative(config.root, m.source.file) + "\n",
      m.root.address,
    );
    const overrides: KustomizeResource["overrides"] = [];
    const walk = (t: Trace, pointer: string) => {
      overrides.push({ pointer, ...t.address });
      if (t.children instanceof Map)
        for (const [k, v] of t.children) walk(v, pointer + "/" + escape(k));
      else if (Array.isArray(t.children))
        t.children.forEach((v, i) => walk(v, pointer + "/" + i));
    };
    walk(m.root, "");
    return {
      source: m.source,
      value: value(m.root) as KustomizeResource["value"],
      overrides,
    };
  });
  const identities = result.map((m) =>
    [
      m.value.apiVersion,
      m.value.kind,
      m.value.metadata.namespace ?? "",
      m.value.metadata.name,
    ].join("|"),
  );
  require(new Set(identities).size ===
    identities.length, "Ambiguous final resource identity");
  return result;
}
