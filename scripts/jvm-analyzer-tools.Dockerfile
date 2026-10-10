FROM public.ecr.aws/docker/library/eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY --chmod=0644 detekt-cli-2.0.0-alpha.6-all.jar spotbugs-4.10.4.tgz kotlin-compiler-2.4.10.zip /opt/checktrail/
RUN chmod 0555 /opt/checktrail
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN echo "d46ca62ea4d62769b5d5c3ba94d49fa9b80ba11c7dba74ddb6df7fcc2c19c5fd  /opt/checktrail/detekt-cli-2.0.0-alpha.6-all.jar" | sha256sum -c -
RUN echo "72bc0d4edd686e462c0f71f42a049b27bf4da6708797ff7b2b56dd202714b4e5  /opt/checktrail/spotbugs-4.10.4.tgz" | sha256sum -c -
RUN echo "473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d  /opt/checktrail/kotlin-compiler-2.4.10.zip" | sha256sum -c -
RUN java --version
