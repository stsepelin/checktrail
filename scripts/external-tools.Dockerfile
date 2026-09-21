FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6 AS go
FROM python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df
COPY --from=node /usr/local /usr/local
COPY --from=node /usr/lib/libstdc++.so* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so* /usr/lib/
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOENV=off GOFLAGS="" GOWORK=off CGO_ENABLED=0
RUN node --version && python3 --version && go version
