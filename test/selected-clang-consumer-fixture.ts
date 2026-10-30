import type { Report } from "../src/types.js";
export async function beginSelectedClangConsumer(
  root: string,
  variant: "broken" | "fixed" | "near-miss",
  phase: "canonical" | "repeat",
  scenario: string,
) {
  if (process.env.CHECKTRAIL_CONSUMER_WITNESS_DIR === undefined) return null;
  const { beginSelectedClangWitness } = await import(
    new URL(
      "../../scripts/selected-clang-consumer-witness.mjs",
      import.meta.url,
    ).href
  );
  return beginSelectedClangWitness(root, variant, phase, scenario);
}
export async function finishSelectedClangConsumer(
  capture: Awaited<ReturnType<typeof beginSelectedClangConsumer>>,
  report: Report,
) {
  if (!capture) return;
  const { finishSelectedClangWitness } = await import(
    new URL(
      "../../scripts/selected-clang-consumer-witness.mjs",
      import.meta.url,
    ).href
  );
  await finishSelectedClangWitness(capture, report);
}
