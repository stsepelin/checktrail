FROM public.ecr.aws/docker/library/node@sha256:1b3abbc0bf2421c8733f58c6fd7bbb961a960f37e05ed7369eccd1fbb0edcc84 AS node
FROM public.ecr.aws/docker/library/swift@sha256:6dd90eb2359663a2cde8f03e9951f488b23134b3b8fce20e9dcb6cada75dd803
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY artifacts/swiftlint /usr/local/bin/swiftlint
COPY artifacts/swiftlint-static /usr/local/bin/swiftlint-static
COPY artifacts/LICENSE artifacts/LICENSE.mimalloc /usr/local/share/licenses/checktrail-swift-tools/
