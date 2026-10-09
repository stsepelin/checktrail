FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
RUN --mount=type=bind,source=artifacts,target=/apks,readonly apk add --no-network /apks/*.apk
ENV PATH="/usr/lib/llvm22/bin:${PATH}"
