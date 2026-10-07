FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY artifacts/bin/ /usr/local/bin/
COPY artifacts/schemas/ /opt/checktrail-schemas/
COPY artifacts/notices/ /opt/checktrail-tool-notices/
