FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
RUN apk add --no-cache clang22=22.1.3-r2 llvm22=22.1.3-r0 g++ musl-dev
ENV PATH="/usr/lib/llvm22/bin:${PATH}"
