FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM mcr.microsoft.com/dotnet/sdk@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256 AS git
FROM public.ecr.aws/docker/library/ruby@sha256:79bf10b28c9d98b7b3cffda01aba8190aa1c1c48513d205ec93372a0e2f010e3
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=git /usr/bin/git /usr/bin/git
COPY --from=git /usr/lib/libpcre2-8.so.0* /usr/lib/
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ruby --disable-gems --version && node --version && npm --version && git --version
