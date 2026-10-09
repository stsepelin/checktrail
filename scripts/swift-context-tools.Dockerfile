FROM public.ecr.aws/docker/library/node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node
FROM public.ecr.aws/docker/library/swift@sha256:471acf16d3ce9b270d2f15ea177b0e150bdf1595ae2acfcc4932d1a03f43c3fd
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && swiftc --version && node --version && npm --version && git --version
