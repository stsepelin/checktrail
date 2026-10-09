FROM rust@sha256:c913be57168b9240b86f373f94060152a2e09ea16a72e0801a02ee3a262ca446 AS compiler
RUN compiler="$(rustup which rustc)" && cp -a "$(dirname "$(dirname "$compiler")")" /opt/checktrail-rust
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6
# These cached, pinned images supply Git and Node without a package download.
# Keep the Alpine Node binary with its musl and C++ runtime dependencies.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /lib/ld-musl-*.so.1 /lib/
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/
RUN node --version && git --version

COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && npm --version

COPY --from=compiler /opt/checktrail-rust /opt/checktrail-rust
COPY --from=compiler /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
ENV PATH=/opt/checktrail-rust/bin:/usr/local/bin:/usr/bin:/bin
RUN rustc --version && node --version && git --version
