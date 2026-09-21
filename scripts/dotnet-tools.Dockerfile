FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM mcr.microsoft.com/dotnet/sdk@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256
COPY --from=node /usr/local/bin/node /usr/local/bin/node
