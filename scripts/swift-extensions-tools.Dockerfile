FROM public.ecr.aws/docker/library/node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node
FROM public.ecr.aws/docker/library/swift@sha256:6dd90eb2359663a2cde8f03e9951f488b23134b3b8fce20e9dcb6cada75dd803
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY artifacts/swiftlint /usr/local/bin/swiftlint
COPY artifacts/swiftlint-static /usr/local/bin/swiftlint-static
COPY artifacts/LICENSE artifacts/LICENSE.mimalloc /usr/local/share/licenses/checktrail-swift-tools/
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && npm --version
