import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  jvmWrapperCiContext,
  jvmWrapperSourceIdentity,
  requireJvmWrapperPhaseOutputs,
} from "./jvm-wrapper-phase-evidence.mjs";
import { requireCiCompletion } from "./ci-impact.mjs";
const plan = JSON.parse(process.env.CHECKTRAIL_CI_PLAN);
const needs = JSON.parse(process.env.CHECKTRAIL_CI_NEEDS);
const report = requireCiCompletion(plan, needs);
if (plan.selected["jvm-wrappers-arm64"]) {
  const source = await jvmWrapperSourceIdentity(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const ci = jvmWrapperCiContext(process.env);
  if (!ci)
    throw new Error(
      "Hosted JVM phase completion requires its workflow identity",
    );
  report.jvmWrapperPhases = requireJvmWrapperPhaseOutputs(
    needs["jvm-wrappers-arm64"].outputs,
    { source: source.sha256, ci },
  );
}
process.stdout.write(JSON.stringify(report) + "\n");
