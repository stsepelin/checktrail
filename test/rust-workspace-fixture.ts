import { spawnSync } from "node:child_process";
export const rustWorkspaceAvailable = ["cargo", "rustc", "rustdoc"].every(
  (tool) =>
    new RegExp("^" + tool + " 1\\.98\\.1 ").test(
      spawnSync(tool, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
      }).stdout ?? "",
    ),
);
export const rustWorkspaceHost =
  /^host: (.+)$/m.exec(
    spawnSync("rustc", ["-vV"], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    }).stdout ?? "",
  )?.[1] ?? "aarch64-unknown-linux-gnu";
export function rustWorkspaceProfiles(
  checks = ["rust.cargo-check", "rust.cargo-test"],
) {
  return {
    schemaVersion: 1,
    workspaceMembers: ["a", "b"],
    profiles: [
      {
        name: "lean",
        checks,
        features: [],
        defaultFeatures: false,
        target: rustWorkspaceHost,
        excludedSources: [
          { path: "a/src/extra.rs", reason: "Module requires a/extra" },
          {
            path: "a/examples/optional.rs",
            reason: "Example requires a/extra",
          },
        ],
      },
      {
        name: "extra",
        checks,
        features: ["a/extra"],
        defaultFeatures: false,
        target: rustWorkspaceHost,
        excludedSources: [],
      },
    ],
  };
}
export function rustWorkspaceFiles(
  checks = ["rust.cargo-check", "rust.cargo-test"],
): Record<string, string> {
  return {
    "Cargo.toml":
      '[workspace]\nresolver="3"\nmembers=["a","b"]\ndefault-members=["a"]\n',
    "Cargo.lock":
      'version=4\n[[package]]\nname="a"\nversion="0.1.0"\n[[package]]\nname="b"\nversion="0.1.0"\ndependencies=["a"]\n',
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks }],
    }),
    "checktrail.rust-build.json": JSON.stringify(rustWorkspaceProfiles(checks)),
    "a/Cargo.toml":
      '[package]\nname="a"\nversion="0.1.0"\nedition="2024"\n[features]\ndefault=[]\nextra=[]\n[[example]]\nname="optional"\nrequired-features=["extra"]\ntest=true\n',
    "a/src/lib.rs":
      '#[cfg(feature="default")] compile_error!("default features must be disabled for this fixture");\n#[cfg(feature="extra")] mod extra;\n/// ```\n/// assert_eq!(a::value(),5);\n/// ```\npub fn value()->i32 {\n#[cfg(feature="extra")] { extra::value() }\n#[cfg(not(feature="extra"))] { 5 }\n}\n#[cfg(test)] mod tests { #[test] fn value_is_five(){assert_eq!(super::value(),5);} }\n',
    "a/src/extra.rs": "pub fn value()->i32 { 5 }\n",
    "a/examples/optional.rs":
      "fn main(){assert_eq!(a::value(),5);}\n#[test] fn optional_test(){assert_eq!(a::value(),5);}\n",
    "b/Cargo.toml":
      '[package]\nname="b"\nversion="0.1.0"\nedition="2024"\n[dependencies]\na={path="../a",default-features=false}\n',
    "b/src/lib.rs":
      "/// ```\n/// assert_eq!(b::value(),5);\n/// ```\npub fn value()->i32 { a::value() }\n#[cfg(test)] mod tests { #[test] fn value_is_five(){assert_eq!(super::value(),5);} }\n",
    "target/preserve": "keep",
  };
}
