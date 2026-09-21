FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) digest=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;; \
      amd64) digest=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;; \
      *) exit 1 ;; \
    esac \
    && wget -q -O /tmp/actionlint.tar.gz "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_${TARGETARCH}.tar.gz" \
    && printf '%s  /tmp/actionlint.tar.gz\n' "$digest" | sha256sum -c - \
    && mkdir -p /usr/local/share/actionlint \
    && tar -xzf /tmp/actionlint.tar.gz -C /usr/local/bin actionlint \
    && tar -xzf /tmp/actionlint.tar.gz -C /usr/local/share/actionlint LICENSE.txt \
    && rm /tmp/actionlint.tar.gz \
    && actionlint -version
