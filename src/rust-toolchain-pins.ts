// Selected official 1.98.1 compiler, LLVM and host/wasm library artifacts.
// This table does not establish system-library, whole-toolchain or license closure.
export const rustNativeToolchainProfile = "linux-arm64-gnu-1.98.1" as const;
export const rustNativeToolchainPins = [
  {
    path: "bin/cargo",
    bytes: 39211776,
    sha256: "2101d7104b91a013912c94275dcd31c2b41061ef7f6e8530df11cdad55b8fbc5",
    link: null,
  },
  {
    path: "bin/cargo-clippy",
    bytes: 1391392,
    sha256: "44ad53b58a0fb84fc09c31c09799a1236f03160ea80549820c881a6e734df806",
    link: null,
  },
  {
    path: "bin/clippy-driver",
    bytes: 15452712,
    sha256: "3bb746414d10f2b96655d9dc36bf3acc9c914ae7ea882ffa74a2c841924aa282",
    link: null,
  },
  {
    path: "bin/rustc",
    bytes: 1262352,
    sha256: "d4217a981a778bfe445c0a29c408f5a25a92e9bb5222701579ad5a35bd913e8f",
    link: null,
  },
  {
    path: "bin/rustdoc",
    bytes: 13699216,
    sha256: "712873f4c4e4371fc2cc7d92e9a78cc1fea7858bf6304a0ae24fd125c2ea8296",
    link: null,
  },
  {
    path: "bin/rustfmt",
    bytes: 5049216,
    sha256: "7aa230a4c704fb7b0e2fbccb90688b5b62d932cf9663805d26bbbe7a99ebae8b",
    link: null,
  },
  {
    path: "lib/libLLVM-22-rust-1.98.1-stable.so",
    bytes: 42,
    sha256: "24d5732dea500078b4e235a69833ccb20d03bf71659a49d58828af8f13f6726c",
    link: null,
  },
  {
    path: "lib/libLLVM.so.22.1-rust-1.98.1-stable",
    bytes: 160074120,
    sha256: "28d8fb033d00b5e23915039f7f18dfb1d5fd142956fcd565d43a1147af8ad241",
    link: null,
  },
  {
    path: "lib/librustc_driver-36de65988ef2d886.so",
    bytes: 101423872,
    sha256: "0f3634e0348cd966e1c44ab210ad195c0733edef4ff032f1e119c0d26debed16",
    link: null,
  },
  {
    path: "lib/rustlib/aarch64-unknown-linux-gnu/lib/liballoc-5ed91a8779ad9241.rlib",
    bytes: 1016388,
    sha256: "f63e69a497069c0659a818b733ef9009121833c2939675aab98e7e206f9dd970",
    link: null,
  },
  {
    path: "lib/rustlib/aarch64-unknown-linux-gnu/lib/libcore-276de952897abe1c.rlib",
    bytes: 3198678,
    sha256: "4a7460dfc298b65f5e830df1624144a549152e317b45cef192f3d8a0dab485ac",
    link: null,
  },
  {
    path: "lib/rustlib/aarch64-unknown-linux-gnu/lib/libstd-96c9fe7a07d47cf2.rlib",
    bytes: 12704848,
    sha256: "49c1714718f01b98278824f13292d161f3adf2c15dfdb5369c8983226d001d20",
    link: null,
  },
  {
    path: "lib/rustlib/aarch64-unknown-linux-gnu/lib/libstd-96c9fe7a07d47cf2.so",
    bytes: 2968560,
    sha256: "4cb4392dc86dbacc27516a65a886045031873289b869df1222ea4b0d41684f68",
    link: null,
  },
  {
    path: "lib/rustlib/wasm32-unknown-unknown/lib/liballoc-c862d99323eeeca9.rlib",
    bytes: 733598,
    sha256: "8b1ff866c80d54af6e54b611b84e039f1a51791afc6d08209e7f2b0b8085a750",
    link: null,
  },
  {
    path: "lib/rustlib/wasm32-unknown-unknown/lib/libcore-95400077a9cf0cb3.rlib",
    bytes: 2545422,
    sha256: "715b1abb81fde1e4cdada47452511b2fe3947d93ffdb5195c8b4992649eb0e68",
    link: null,
  },
  {
    path: "lib/rustlib/wasm32-unknown-unknown/lib/libstd-41456b1043900b6a.rlib",
    bytes: 2699056,
    sha256: "6882c6a56d1f6aebeaa0a04cea790c83abec85e46228d448d0dc089413804501",
    link: null,
  },
] as const;
