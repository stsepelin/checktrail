import process from "node:process";
export { runAcceptanceNpm as runAuditNpm } from "./install-acceptance-package.mjs";

export function auditLibcFromReport(report, architecture) {
  if (!report || typeof report !== "object") return null;
  const glibc =
    typeof report.header?.glibcVersionRuntime === "string" &&
    /^[0-9]+\.[0-9]+(?:\.[0-9]+)*$/.test(report.header.glibcVersionRuntime);
  const loader = {
    x64: "/lib/ld-musl-x86_64.so.1",
    arm64: "/lib/ld-musl-aarch64.so.1",
  }[architecture];
  const musl =
    typeof loader === "string" &&
    Array.isArray(report.sharedObjects) &&
    report.sharedObjects.includes(loader);
  if (glibc === musl) return null;
  return glibc ? "glibc" : "musl";
}

export function observeAuditLibc(
  platform = process.platform,
  architecture = process.arch,
  reporter = process.report,
) {
  if (platform !== "linux" || typeof reporter?.getReport !== "function")
    return null;
  const network = reporter.excludeNetwork,
    environment = reporter.excludeEnv;
  try {
    reporter.excludeNetwork = true;
    reporter.excludeEnv = true;
    return auditLibcFromReport(reporter.getReport(), architecture);
  } catch {
    return null;
  } finally {
    reporter.excludeNetwork = network;
    reporter.excludeEnv = environment;
  }
}
