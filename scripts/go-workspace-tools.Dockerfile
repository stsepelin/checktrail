FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node /lib/ld-musl-*.so.1 /lib/
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/
# The preparation receipt binds the verified Go archive and analyzer bytes.
COPY go /opt/checktrail-go
COPY bin /opt/checktrail-go-tools
ENV GOROOT=/opt/checktrail-go
ENV PATH=/opt/checktrail-go/bin:/opt/checktrail-go-tools:$PATH
ENV GOPROXY=off GOTOOLCHAIN=local GOWORK=off GOENV=off
ENV GOCACHE=/tmp/go-cache
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && node --version && go version && staticcheck -version && golangci-lint version --short
