FROM public.ecr.aws/docker/library/eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY detekt-cli-2.0.0-alpha.6-all.jar /opt/checktrail/detekt-cli-2.0.0-alpha.6-all.jar
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN echo "d46ca62ea4d62769b5d5c3ba94d49fa9b80ba11c7dba74ddb6df7fcc2c19c5fd  /opt/checktrail/detekt-cli-2.0.0-alpha.6-all.jar" | sha256sum -c -
RUN java --version
