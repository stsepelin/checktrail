import { spawnSync } from "node:child_process";
import { z } from "zod";
export const rubyExtensionsUnavailableSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["rubocop", "rspec", "minitest"]),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  prerequisite: z.literal("unavailable"),
});
/** Probe only the selected interpreter and Bundler, before any project DSL. */
export function rubyExtensionsPrerequisite(env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    "ruby",
    [
      "--disable-gems",
      "-r",
      "rubygems",
      "-e",
      'gem "bundler", "=4.0.20";require "bundler";print [RUBY_VERSION,RUBY_ENGINE,RUBY_PATCHLEVEL,Bundler::VERSION].join("\\n")',
    ],
    {
      env,
      encoding: "utf8",
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready =
    !result.error &&
    !result.signal &&
    result.status === 0 &&
    result.stderr === "" &&
    result.stdout === "4.0.7\nruby\n0\n4.0.20";
  return ready;
}
