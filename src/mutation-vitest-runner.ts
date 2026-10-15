import path from "node:path";
import { pathToFileURL } from "node:url";
import { withinRoot } from "./inventory.js";
import { mutationBoundedBytes } from "./mutation-native-copy.js";
import type { Reporter, TestModule, TestCase, Vitest } from "vitest/node";

// This collector reads native structured errors instead of matching a rendered
// failure-message prefix. It is used only by the selected flat mutation profile.
async function main() {
  const [entry, inputRoot, ...selected] = process.argv.slice(2);
  if (!entry || !inputRoot || selected.length < 1 || selected.length > 16)
    throw new Error("Selected mutation Vitest arguments are invalid");
  const root = await withinRoot(inputRoot, "."),
    tool = await withinRoot(root, path.relative(inputRoot, entry));
  const metadata = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await mutationBoundedBytes(
        root,
        path.relative(
          root,
          path.resolve(path.dirname(tool), "../package.json"),
        ),
        65536,
      ),
    ),
  );
  if (metadata.name !== "vitest" || metadata.version !== "5.0.1")
    throw new Error("Selected mutation Vitest pin differs");
  const files = await Promise.all(
    selected.map((file) => withinRoot(root, file)),
  );
  if (new Set(files).size !== files.length)
    throw new Error("Selected mutation files are repeated");
  const { startVitest, VitestPackageInstaller } = (await import(
    pathToFileURL(tool).href
  )) as typeof import("vitest/node");
  class InstalledOnly extends VitestPackageInstaller {
    override async ensureInstalled(
      dependency: string,
      cwd: string,
    ): Promise<boolean> {
      if (!this.isPackageExists(dependency, { paths: [cwd] }))
        throw new Error("Selected mutation dependency is unavailable");
      return true;
    }
  }
  const errors = (
    values: readonly { name?: string; message?: string }[] | undefined,
  ) => (values ?? []).map((error) => ({ name: error.name ?? "unknown" }));
  type HookRecord = {
    name: string;
    file: string;
    caseName: string | null;
    beforeErrors: number;
    afterErrors: number | null;
    completed: boolean;
  };
  const hooks: HookRecord[] = [];
  const hookErrors = (
    entity: TestModule | TestCase | import("vitest/node").TestSuite,
  ) =>
    entity.type === "test"
      ? (entity.result().errors?.length ?? 0)
      : entity.errors().length;
  const hookIdentity = (
    hook: Parameters<NonNullable<Reporter["onHookStart"]>>[0],
  ) => ({
    name: hook.name,
    file:
      hook.entity.type === "module"
        ? hook.entity.moduleId
        : hook.entity.module.moduleId,
    caseName: hook.entity.type === "test" ? hook.entity.fullName : null,
  });
  let context: Vitest | undefined, receipt: unknown;
  const reporter: Reporter = {
    onHookStart(hook) {
      hooks.push({
        ...hookIdentity(hook),
        beforeErrors: hookErrors(hook.entity),
        afterErrors: null,
        completed: false,
      });
    },
    onHookEnd(hook) {
      const identity = hookIdentity(hook),
        record = hooks.findLast(
          (h) =>
            h.name === identity.name &&
            h.file === identity.file &&
            h.caseName === identity.caseName &&
            !h.completed,
        );
      if (!record) throw Error("Native hook end lacks its start");
      record.afterErrors = hookErrors(hook.entity);
      record.completed = true;
    },
    onInit(ctx) {
      context = ctx;
    },
    onTestRunEnd(modules: readonly TestModule[], unhandled, reason) {
      const records = modules.map((module) => {
        const children = module.children.array();
        return {
          file: module.moduleId,
          state: module.state(),
          errors: errors(module.errors()),
          flat: children.every((child) => child.type === "test"),
          cases: children
            .filter((child): child is TestCase => child.type === "test")
            .map((child) => ({
              name: child.name,
              fullName: child.fullName,
              parent: child.parent.type,
              location: child.location,
              mode: child.options.mode,
              retry: child.options.retry ?? 0,
              fails: child.options.fails ?? false,
              state: child.result().state,
              errors: errors(child.result().errors),
            })),
        };
      });
      receipt = {
        schemaVersion: 1,
        format: "checktrail-mutation-vitest-1",
        version: metadata.version,
        selectedFiles: files,
        endReason: reason,
        modules: records,
        unhandled: errors(unhandled),
        hooks,
      };
    },
  };
  const ctx = await startVitest(
    files,
    {
      root,
      run: true,
      watch: false,
      update: "none",
      allowOnly: false,
      passWithNoTests: false,
      dangerouslyIgnoreUnhandledErrors: false,
      onUnhandledError: () => true,
      cache: false,
      fsModuleCache: false,
      includeTaskLocation: true,
      retry: 0,
      reporters: [reporter],
    },
    undefined,
    { packageInstaller: new InstalledOnly() },
  );
  try {
    if (!context || !receipt)
      throw new Error("Selected native mutation collection did not finish");
    process.stdout.write(JSON.stringify(receipt) + "\n");
    // Native state, not a recipe-supplied verdict, controls the subprocess status.
    process.exitCode =
      ctx.state.getTestModules().some((module) => !module.ok()) ||
      ctx.state.getUnhandledErrors().length
        ? 1
        : 0;
  } finally {
    await ctx.close();
  }
}
main().catch(() => {
  process.stderr.write(
    "Selected mutation Vitest collection is unavailable or incomplete\n",
  );
  process.exitCode = 2;
});
