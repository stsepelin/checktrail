# CI-only retained native archives

The two Alpine v3.24 `zlib-1.3.2-r0.apk` files are unchanged signed public archives
for aarch64 and x86_64. They retain the byte counts and SHA-256 values already
frozen in `scripts/ruby-tools-archives.json`. The primary Alpine CDN supplied
those exact bytes during the recorded delivery check; tested secondary mirrors
returned 404 for both revisions. No compiler or dependency version was upgraded.

`request-ruby-compiler-archive.mjs` reads only this exact bundled filename from the
selected architecture. It refuses absent, symlinked, multiply linked, replaced,
wrong-sized or changed-digest files. An explicit existing operator archive
folder still supplies every selected compiler archive. Other archives use the
bounded official-mirror path and retain their original pins. The offline image
build continues to enforce APK signatures; unchecked replacement archives cannot
satisfy preparation. These files are outside the npm package allowlist.

Both archives declare `pkgname = zlib`, `pkgver = 1.3.2-r0`, `license = Zlib` and
Alpine source commit `f248b33b5943c7dc69bf691031d7612ab2e8ed93` in `.PKGINFO`.
The unchanged upstream notice is in
[`docs/UPSTREAM-NOTICES/zlib-1.3.2.txt`](../../docs/UPSTREAM-NOTICES/zlib-1.3.2.txt),
bound to zlib v1.3.2 commit `da607da739fa6047df13e66a2af6b8bec7c2a498`.
Complete compiler, SDK, native-library and license closure remains pending.
These public third-party tool archives are not project fixtures.
