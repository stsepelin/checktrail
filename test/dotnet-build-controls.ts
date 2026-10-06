import { spawnSync } from "node:child_process";
import { validate } from "../src/engine.js";
export const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
export const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
};
export const run = (root: string) =>
  validate(root, {
    trusted: true,
    timeoutMs: 120000,
  });
