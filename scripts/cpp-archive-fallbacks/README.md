# Original C++ preparation archive

`zlib-1.3.2-r0.apk` is the unchanged, signed Alpine Linux ARM64 archive originally
acquired from [Alpine v3.24 main](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/zlib-1.3.2-r0.apk).
Its byte count and SHA-256 must match `../cpp-tools-archives.json`. The repository
copy preserves that original pin after the live package inventory replaced it
with revision r1; a cached CDN response is not a durable acquisition source.

The acquisition helper admits this exact archive only after the bounded original
repository searches and final primary retries end in HTTP 404. Other filenames,
pins, integrity failures and permanent errors cannot select this fallback. Normal
APK signature verification still runs in the offline image build. This file is a
public build dependency, separate from the synthetic acceptance fixtures, and is
outside the npm package's published file inventory.

The upstream project is [zlib](https://github.com/madler/zlib/tree/v1.3.2), by
Jean-loup Gailly and Mark Adler. `LICENSE.zlib` preserves the upstream v1.3.2
[license](https://github.com/madler/zlib/blob/v1.3.2/LICENSE). No source or binary
changes were made. This notice does not establish the remaining toolchain's
publisher or license closure.
