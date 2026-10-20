# Original C++ preparation archives

`zlib-1.3.2-r0.apk` is the unchanged, signed Alpine Linux ARM64 archive originally
acquired from [Alpine v3.24 main](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/zlib-1.3.2-r0.apk).
Its byte count and SHA-256 must match `../cpp-tools-archives.json`. The repository
copy preserves that original pin after the live package inventory replaced it
with revision r1; a cached CDN response is not a durable acquisition source.

The acquisition helper admits these exact archives only after the bounded original
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

`libexpat-2.8.5-r0.apk` preserves the exact signed Alpine Linux ARM64 archive
originally acquired from [Alpine v3.24 main](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libexpat-2.8.5-r0.apk).
C++ CI preparation encountered terminal HTTP 404 responses for this pin. A copy
matching the existing manifest's byte count and SHA-256 is retained under the
same bounded acquisition and signature-verification rules as zlib. This changes
neither dependency version nor archive bytes; cached CDN availability is not a
durable acquisition guarantee.

The upstream project is [Expat](https://github.com/libexpat/libexpat/tree/R_2_8_5),
by its maintainers. `LICENSE.expat` preserves the upstream release's
[MIT license](https://github.com/libexpat/libexpat/blob/R_2_8_5/expat/COPYING).
No source or binary changes were made. Both retained archives remain outside
the published npm package and separate from synthetic acceptance fixtures.
