import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import {
  rubyToolsEvidence,
  rubyToolsPacketSchema,
} from "../src/ruby-tools-evidence.js";
import { mavenHash } from "../src/maven.js";
import { rubyToolsFixture } from "./ruby-tools-fixture.js";
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
  timeout: 600000,
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
test(
  "native Ruby artifact runtime entry point settings scope compiler and result mutations cannot yield pass",
  native,
  async (t) => {
    for (const mode of ["rubocop", "rspec", "minitest"]) {
      const { root } = await rubyToolsFixture(t, [`ruby.${mode}`]),
        plan = (await createPlan(root)).plan,
        report = await run(root),
        check = plan.checks[0]!,
        process = report.checks[0]!.processes[0]!;
      assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
      const original = rubyToolsPacketSchema.parse(JSON.parse(process.stdout));
      const reject = (edit: (p: typeof original) => void) => {
        const packet = structuredClone(original);
        edit(packet);
        const result = rubyToolsEvidence(check, [
          { ...process, stdout: JSON.stringify(packet) },
        ]);
        assert.equal(result.status, "inconclusive", JSON.stringify(result));
      };
      reject((p) => {
        p.dataSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.installedArtifacts.sha256 = "0".repeat(64);
      });
      reject((p) => {
        p.installedArtifactsAfter.sha256 = "0".repeat(64);
      });
      reject((p) => {
        p.installedArtifacts.entries.push(p.installedArtifacts.entries[0]!);
      });
      reject((p) => {
        p.metadataSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.inputSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.observerSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.optionsSha256 = "0".repeat(64);
      });
      reject((p) => {
        p.receipts[0]!.exitCode = 1;
      });
      reject((p) => {
        p.receipts[1]!.phase = "other";
      });
      const meta = (
        p: typeof original,
        edit: (v: Record<string, unknown>) => void,
      ) => {
        const value = JSON.parse(p.metadata);
        edit(value);
        p.metadata = JSON.stringify(value);
        p.metadataSha256 = mavenHash(p.metadata);
      };
      reject((p) =>
        meta(p, (v) => {
          v.ruby = "4.0.8";
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.toolFile = "/foreign/native.rb";
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.toolVersion = "9.0.0";
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.toolFileSha256 = "0".repeat(64);
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          (v.compiled as { sha256: string }[])[0]!.sha256 = "0".repeat(64);
        }),
      );
      reject((p) =>
        meta(p, (v) => {
          v.compiled = [];
        }),
      );
      if (mode !== "rubocop") {
        const data = (
          p: typeof original,
          edit: (v: Record<string, unknown>) => void,
        ) => {
          const value = JSON.parse(p.data);
          edit(value);
          p.data = JSON.stringify(value);
          p.dataSha256 = mavenHash(p.data);
        };
        reject((p) =>
          data(p, (v) => {
            v.started = [];
          }),
        );
        reject((p) =>
          data(p, (v) => {
            v.results = [];
          }),
        );
        reject((p) =>
          data(p, (v) => {
            const rows = v.rows as { id: string }[];
            rows.push(rows[0]!);
          }),
        );
        reject((p) =>
          data(p, (v) => {
            const results = v.results as { file: string }[];
            results[0]!.file = "spec/absent.rb";
          }),
        );
        reject((p) =>
          data(p, (v) => {
            (v.summary as { total: number }).total = 3;
          }),
        );
        reject((p) =>
          data(p, (v) => {
            (v.summary as { outsideErrors: number }).outsideErrors = 1;
          }),
        );
      }
    }
  },
);
