export const kotlinArtifacts = {
  version: "2.4.10",
  archiveBytes: 87077443,
  archiveSha256:
    "473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d",
  profile: "jvm-source-frontend-ir-output-v1",
  runtimeLibraries: [
    {
      name: "kotlin-compiler.jar",
      bytes: 61903538,
      sha256:
        "db12b1af0db0e10eeedfc15d5dac0316604e5c556321f60e3bcd73075a66f0a3",
    },
    {
      name: "kotlin-stdlib.jar",
      bytes: 1841933,
      sha256:
        "4ec0293bc3751423b203f1d8493251c57c42e73eb6377a6b8560d0974ff0a6df",
    },
    {
      name: "kotlin-reflect.jar",
      bytes: 3750100,
      sha256:
        "25a1aef7454d46548ecaaf51021b0e52e38141a62ed75af124da109b7324c4e5",
    },
    {
      name: "kotlinx-coroutines-core-jvm.jar",
      bytes: 1548360,
      sha256:
        "9860906a1937490bf5f3b06d2f0e10ef451e65b95b269f22daf68a3d1f5065c5",
    },
    {
      name: "annotations-13.0.jar",
      bytes: 17536,
      sha256:
        "ace2a10dc8e2d5fd34925ecac03e4988b2c0f851650c94b8cef49ba1bd111478",
    },
    {
      name: "kotlin-script-runtime.jar",
      bytes: 46565,
      sha256:
        "f4a5b30c2fdfbe386b097101b7989dbeea3743c06396136664784e08e15c6899",
    },
  ],
  compilerManifestClassPath: [
    "annotations-13.0.jar",
    "kotlin-stdlib.jar",
    "kotlin-reflect.jar",
    "kotlin-script-runtime.jar",
    "kotlinx-coroutines-core-jvm.jar",
  ],
} as const;
