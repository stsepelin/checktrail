FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM composer@sha256:b09bccd91a78fe8a9ab4b33d707b862e8fe54fec17782e32683ad2a69c46867d
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so* /usr/lib/
ENTRYPOINT []
CMD ["node", "--version"]

COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && node --version && git --version && php --version && npm --version
