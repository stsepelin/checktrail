export const scala2Artifacts = {
  version: "2.13.18",
  profile: "linux-arm64-scala2-typed-class-v1",
  runtimeLibraries: [
    {
      path: "lib/scala-reflect.jar",
      name: "scala-reflect.jar",
      bytes: 3814367,
      sha256:
        "6935ff1982b2ac93d695f15aa66921be2f602921277afe002f018fd8c7d6e29b",
    },
    {
      path: "lib/java-diff-utils-4.16.jar",
      name: "java-diff-utils-4.16.jar",
      bytes: 78743,
      sha256:
        "620403030d676a4a27f780a3acec7438dee1b1651a1c804fa6bb11bb07399a6f",
    },
    {
      path: "lib/scala-library.jar",
      name: "scala-library.jar",
      bytes: 5940741,
      sha256:
        "4e85d96ff7bc7dc627985523c3541b9917aaa08e956391380c42db21a2c4e5a0",
    },
    {
      path: "lib/scala-compiler.jar",
      name: "scala-compiler.jar",
      bytes: 12343847,
      sha256:
        "2f15891fcae7aad30a3892194fb2abb6224cf7ce5d2bd90fba7f1c48682fca21",
    },
    {
      path: "lib/jline-3.29.0.jar",
      name: "jline-3.29.0.jar",
      bytes: 1371851,
      sha256:
        "ed2680487642df95379f220c09c0f77e25095713387e2bc00c2d6581bb79c804",
    },
  ],
  archiveBytes: 22720670,
  archiveSha256:
    "9c90562f29b0a316e269474d6752bc8ec45b1cabf61d5401d7ca50407b3a9d2b",
} as const;
