import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { lifecycle } from "./ruby-tools-lifecycle-fixture.js";
const available =
  !!process.env.CHECKTRAIL_RUBY_TOOLS_CACHE &&
  /^ruby 4\.0\.7 /.test(
    spawnSync("ruby", ["--disable-gems", "--version"], { encoding: "utf8" })
      .stdout || "",
  );
const native = {
  skip: available
    ? false
    : "Pinned Ruby runtime and dependency cache not selected",
  timeout: 1200000,
};
test(
  "native Ruby Minitest skipped empty setup teardown and after-run hooks retain honest terminal accounting",
  native,
  (t) => lifecycle(t, "minitest"),
);
