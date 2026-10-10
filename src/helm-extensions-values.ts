import path from "node:path";
import { helmRequire } from "./helm.js";
import {
  helmExtensionsGraph,
  type HelmExtensionsConfig,
  type HelmExtensionsValue,
} from "./helm-extensions-contract.js";
export type HelmExtensionsOrigin = { file: string; pointer: string };
type OriginValue = {
  values: Record<string, HelmExtensionsValue>;
  origins: Map<string, HelmExtensionsOrigin>;
};
export function helmExtensionsValues(
  config: HelmExtensionsConfig,
  start = config.charts[0]!.id,
) {
  helmExtensionsGraph(config);
  const result: {
    id: string;
    name: string;
    address: string;
    values: Record<string, HelmExtensionsValue>;
    origins: Map<string, HelmExtensionsOrigin>;
  }[] = [];
  const owned = (c: HelmExtensionsConfig["charts"][number]): OriginValue => {
    const origins = new Map<string, HelmExtensionsOrigin>(),
      file = path.posix.join(c.directory, "values.yaml");
    const walk = (v: Record<string, HelmExtensionsValue>, prefix: string) => {
      for (const [k, value] of Object.entries(v)) {
        const pointer = prefix + "/" + k;
        if (typeof value === "object") walk(value, pointer);
        else origins.set(pointer, { file, pointer });
      }
    };
    walk(c.values, "");
    return { values: structuredClone(c.values), origins };
  };
  const merge = (base: OriginValue, override: OriginValue): OriginValue => {
    const values = structuredClone(base.values),
      origins = new Map(base.origins);
    const walk = (
      to: Record<string, HelmExtensionsValue>,
      from: Record<string, HelmExtensionsValue>,
      prefix: string,
    ) => {
      for (const [k, v] of Object.entries(from)) {
        const pointer = prefix + "/" + k;
        if (typeof v === "object") {
          const current = Object.hasOwn(to, k) ? to[k] : undefined;
          helmRequire(
            current === undefined || typeof current === "object",
            "Scalar/object coalescing requires another profile",
          );
          to[k] = typeof current === "object" ? current : {};
          walk(to[k] as Record<string, HelmExtensionsValue>, v, pointer);
        } else {
          to[k] = v;
          const origin = override.origins.get(pointer);
          helmRequire(
            origin,
            "Every override scalar must have a physical origin",
          );
          origins.set(pointer, origin);
        }
      }
    };
    walk(values, override.values, "");
    return { values, origins };
  };
  const visit = (
    id: string,
    name: string,
    address: string,
    override?: OriginValue,
  ) => {
    const c = config.charts.find((c) => c.id === id)!,
      effective = override ? merge(owned(c), override) : owned(c);
    result.push({ id, name, address, ...effective });
    for (const d of c.dependencies) {
      const value = effective.values[d.alias];
      helmRequire(
        value === undefined || typeof value === "object",
        "Dependency values must be objects",
      );
      const origins = new Map<string, HelmExtensionsOrigin>();
      for (const [pointer, origin] of effective.origins) {
        const prefix = "/" + d.alias + "/";
        if (pointer.startsWith(prefix))
          origins.set(pointer.slice(d.alias.length + 1), origin);
      }
      visit(d.target, d.alias, address + "/charts/" + d.alias, {
        values: typeof value === "object" ? value : {},
        origins,
      });
    }
  };
  const root = config.charts.find((chart) => chart.id === start)!;
  visit(root.id, root.name, root.name);
  return result;
}
export function helmExtensionsValueIssues(
  config: HelmExtensionsConfig,
  start = config.charts[0]!.id,
) {
  const issues: {
    name: string;
    address: string;
    message: string;
    origin: HelmExtensionsOrigin;
  }[] = [];
  for (const instance of helmExtensionsValues(config, start)) {
    const c = config.charts.find((c) => c.id === instance.id)!;
    const missing = Object.keys(c.properties)
      .toSorted()
      .filter((k) => !Object.hasOwn(instance.values, k));
    if (missing.length) {
      const message =
        "- at '': missing " +
        (missing.length === 1 ? "property " : "properties ") +
        missing.map((k) => "'" + k + "'").join(", ");
      issues.push({
        name: instance.name,
        address: instance.address,
        message,
        origin: {
          file: path.posix.join(c.directory, "values.schema.json"),
          pointer:
            "/required/" +
            Object.keys(c.properties).toSorted().indexOf(missing[0]!),
        },
      });
    }
    for (const [k, schema] of Object.entries(c.properties)) {
      if (!Object.hasOwn(instance.values, k)) continue;
      const v = instance.values[k]!,
        origin = instance.origins.get("/" + k);
      helmRequire(origin, "Value origin missing");
      const add = (detail: string) =>
        issues.push({
          name: instance.name,
          address: instance.address,
          message: "- at '/" + k + "': " + detail,
          origin,
        });
      const type =
        typeof v === "number"
          ? Number.isInteger(v)
            ? "integer"
            : "number"
          : typeof v;
      if (type !== schema.type) {
        add("got " + type + ", want " + schema.type);
        continue;
      }
      if (schema.type === "integer" && typeof v === "number") {
        if (schema.minimum !== undefined && v < schema.minimum)
          add("minimum: got " + v + ", want " + schema.minimum);
        if (schema.maximum !== undefined && v > schema.maximum)
          add("maximum: got " + v + ", want " + schema.maximum);
      }
      if (schema.type === "string" && typeof v === "string") {
        if (schema.minLength !== undefined && v.length < schema.minLength)
          add("minLength: got " + v.length + ", want " + schema.minLength);
        if (schema.maxLength !== undefined && v.length > schema.maxLength)
          add("maxLength: got " + v.length + ", want " + schema.maxLength);
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(v))
          add("'" + v + "' does not match pattern '" + schema.pattern + "'");
        if (schema.enum !== undefined && !schema.enum.includes(v))
          add(
            schema.enum.length === 1
              ? "value must be '" + schema.enum[0] + "'"
              : "value must be one of " +
                  schema.enum.map((x) => "'" + x + "'").join(", "),
          );
      }
    }
  }
  return issues;
}
