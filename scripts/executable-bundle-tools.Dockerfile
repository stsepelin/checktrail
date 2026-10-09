FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM public.ecr.aws/docker/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6 AS go
FROM public.ecr.aws/docker/library/python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df AS python
FROM public.ecr.aws/docker/library/composer@sha256:b09bccd91a78fe8a9ab4b33d707b862e8fe54fec17782e32683ad2a69c46867d
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so* /usr/lib/
COPY --from=go /usr/local/go /usr/local/go
COPY --from=python /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python /usr/local/lib /usr/local/lib
RUN ln -s python3.12 /usr/local/bin/python3
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOENV=off GOFLAGS="" GOWORK=off CGO_ENABLED=0
RUN node --version && php -n --version && go version && openssl version && python3 -I -B -c "import json, hashlib, ssl; import sys; print(sys.version); print(ssl.OPENSSL_VERSION)"
ENTRYPOINT []
CMD ["node", "--version"]
