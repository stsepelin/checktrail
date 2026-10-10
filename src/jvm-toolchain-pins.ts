// Selected Temurin 25.0.4+7 Linux ARM64 launcher and compiler-module bytes.
// This table does not cover the complete JDK or system-library closure.
export const jvmToolchainPins = [
  {
    path: "bin/java",
    bytes: 12672,
    sha256: "bf14eecd544fe58970e7349aa1e7edf4b446927a731670b4d824d180f2622c0a",
  },
  {
    path: "bin/javac",
    bytes: 12768,
    sha256: "1c8860f38047e666c25a9bfa74537d0e79f65f55bf50808e20b4b63e6c73283f",
  },
  {
    path: "bin/jar",
    bytes: 12752,
    sha256: "20b171e5ea1f56e67380b23fc56347541988a08ad35b1c8cf8c132835639534c",
  },
  {
    path: "lib/modules",
    bytes: 145699541,
    sha256: "8ef38b5ace821f5d0439b7961e35805677d94089ed3c82eff429a0f6b7b4f425",
  },
] as const;
