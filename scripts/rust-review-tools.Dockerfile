FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM rust@sha256:c913be57168b9240b86f373f94060152a2e09ea16a72e0801a02ee3a262ca446
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so* /usr/lib/
ENV RUSTUP_AUTO_INSTALL=0
RUN rustup component add --toolchain 1.98.1 rustfmt clippy
RUN compiler="$(rustup which rustc)" && ln -s "$(dirname "$compiler")" /opt/checktrail-rust-bin
ENV PATH=/opt/checktrail-rust-bin:/usr/local/bin:/usr/bin:/bin
RUN cargo --version && rustc --version && rustfmt --version && cargo-clippy --version
ENTRYPOINT []
CMD ["node", "--version"]
