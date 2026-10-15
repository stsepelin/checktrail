import process from "node:process";
import { requireCiCompletion } from "./ci-impact.mjs";
const report = requireCiCompletion(
  JSON.parse(process.env.CHECKTRAIL_CI_PLAN),
  JSON.parse(process.env.CHECKTRAIL_CI_NEEDS),
);
process.stdout.write(JSON.stringify(report) + "\n");
