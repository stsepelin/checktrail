import { Buffer } from "node:buffer";
const text = (value) =>
  typeof value === "string"
    ? value
    : Buffer.isBuffer(value)
      ? value.toString("utf8")
      : "";
// Setup diagnostics only. Keep the original failure and raw output unchanged.
export function nativeAcceptanceFailure(error) {
  for (const value of [error?.stdout, error?.stderr]) {
    const output = text(value);
    for (const line of output.split("\n")) {
      let receipt;
      try {
        receipt = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !receipt ||
        receipt.complete !== false ||
        !Array.isArray(receipt.problems) ||
        !receipt.problems.length
      )
        continue;
      return (
        "Required native acceptance failed: " +
        JSON.stringify({
          profile:
            typeof receipt.profile === "string"
              ? receipt.profile.slice(0, 128)
              : null,
          passed: Number.isSafeInteger(receipt.passed) ? receipt.passed : null,
          required: Number.isSafeInteger(receipt.required)
            ? receipt.required
            : null,
          problems: receipt.problems.slice(0, 4).map((p) => ({
            name: typeof p?.name === "string" ? p.name.slice(0, 128) : null,
            reason:
              typeof p?.reason === "string" ? p.reason.slice(0, 128) : null,
            code: typeof p?.code === "string" ? p.code.slice(0, 128) : null,
            message:
              typeof p?.message === "string" ? p.message.slice(0, 1000) : null,
          })),
        }).slice(0, 2800)
      );
    }
  }
  const output =
    text(error?.stderr) || text(error?.stdout) || text(error?.message);
  return (
    "Native acceptance subprocess failed: " +
    JSON.stringify({
      head: output.slice(0, 900),
      tail: output.slice(-900),
    }).slice(0, 2800)
  );
}
