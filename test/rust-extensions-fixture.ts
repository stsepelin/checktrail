import { type TestContext } from "node:test";
import { rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fixture } from "./helpers.js";
import {
  rustWorkspaceFiles,
  rustWorkspaceProfiles,
} from "./rust-workspace-fixture.js";
import { rustBuildPolicySchema } from "../src/rust-build.js";
import type { CheckResult } from "../src/types.js";
import type { z } from "zod";
import { rustWorkspacePacketSchema } from "../src/rust-workspace-schema.js";
export type RustNative = z.infer<typeof rustWorkspacePacketSchema> & {
  sourceFingerprint: string;
  inputsStable: boolean;
};
export const rustExtensionsSkip =
  process.platform === "linux" &&
  process.arch === "arm64" &&
  /^rustc 1\.98\.1 /.test(
    spawnSync("rustc", ["--version"], { encoding: "utf8", timeout: 10000 })
      .stdout ?? "",
  )
    ? false
    : "Prepared Linux ARM64 Rust extension runtime unavailable";
export const rustChecks = [
  "rust.cargo-check",
  "rust.cargo-clippy",
  "rust.cargo-test",
];
export const rustExtra = (fixed = false) =>
  "pub fn value()->i32 { 5 }\npub fn decision(value:&str)->bool { " +
  (fixed
    ? 'value=="grant" || value.starts_with("grant:")'
    : 'value.starts_with("grant")') +
  " }\n";
export async function rustAtomic(file: string, text: string) {
  await writeFile(file + ".replacement", text);
  await rename(file + ".replacement", file);
}
export async function rustOriginal(
  t: TestContext,
  options: { fixed?: boolean; checks?: string[]; foreign?: boolean } = {},
) {
  const checks = options.checks ?? rustChecks;
  const raw = rustWorkspaceProfiles(checks);
  if (options.foreign !== false && checks.some((c) => c !== "rust.cargo-test"))
    raw.profiles.push({
      ...raw.profiles[1]!,
      name: "wasm-extra",
      checks: checks.filter((c) => c !== "rust.cargo-test"),
      target: "wasm32-unknown-unknown",
    });
  const policy = rustBuildPolicySchema.parse({
    ...raw,
    profiles: raw.profiles.map((p) => ({
      ...p,
      nativeToolchain: "linux-arm64-gnu-1.98.1",
    })),
  });
  const files = rustWorkspaceFiles(checks);
  files["checktrail.rust-build.json"] = JSON.stringify(policy);
  files["a/src/extra.rs"] = rustExtra(options.fixed);
  files["a/src/lib.rs"] +=
    '\npub fn decision(value:&str)->bool { #[cfg(feature="extra")] {extra::decision(value)} #[cfg(not(feature="extra"))] {value=="grant" || value.starts_with("grant:")} }\n#[test] fn identifier_boundary(){assert!(!decision("grantToken"));assert!(!decision("grantToken:read"));}\n#[test] fn exact_and_delimited(){assert!(decision("grant"));assert!(decision("grant:read"));assert!(!decision("regrant"));}\n';
  files["a/.checktrail/keep"] = "original retained marker";
  return { root: await fixture(t, files), policy };
}
export function rustReceipt(check: CheckResult): RustNative {
  return rustWorkspacePacketSchema.parse(
    JSON.parse(check.processes[0]!.stdout),
  ) as RustNative;
}
export function rustWaitingSource(mode: string): string {
  return `#[test] fn native_waiting(){use std::io::Write;use std::process::{Command,Stdio};use std::time::Duration;unsafe extern "C" {fn setsid()->i32;}let marker=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".checktrail");if std::env::var("CHECKTRAIL_ORIGINAL_RUST_WORKER").as_deref()==Ok("child") {unsafe{assert!(setsid()>0);}std::fs::write(marker.join("child.ready"),std::process::id().to_string()).unwrap();loop{if marker.join("release").exists(){std::io::stdout().write_all(&vec![b'x';65536]).unwrap();std::io::stdout().flush().unwrap();}std::thread::sleep(Duration::from_millis(10));}}let mut child=Command::new(std::env::current_exe().unwrap()).args(["--exact","native_waiting","--test-threads=1","--nocapture"]).env("CHECKTRAIL_ORIGINAL_RUST_WORKER","child").stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().unwrap();while !marker.join("child.ready").exists(){std::thread::sleep(Duration::from_millis(10));}let exe=std::env::current_exe().unwrap();let build=exe.ancestors().find(|p|p.file_name().is_some_and(|n|n.to_string_lossy().starts_with("checktrail-rust-workspace-"))).unwrap();let temporary=std::env::var("CHECKTRAIL_TEMP").unwrap_or_default();let data=format!("{{\\"token\\":\\"${mode}\\",\\"parent\\":{},\\"child\\":{},\\"build\\":\\"{}\\",\\"temporary\\":\\"{}\\"}}",std::process::id(),child.id(),build.display(),temporary);std::fs::write(marker.join("parent.pending"),data).unwrap();std::fs::rename(marker.join("parent.pending"),marker.join("parent.ready")).unwrap();loop{let _=child.try_wait();std::thread::sleep(Duration::from_millis(10));}}`;
}
