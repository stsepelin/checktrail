FROM eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY scala3-3.9.0.zip /opt/checktrail/scala3-3.9.0.zip
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN echo "2ec08ce51e400090058ad075fff0be764c7e16fb827d299c1be0d053d425770c  /opt/checktrail/scala3-3.9.0.zip" | sha256sum -c -
RUN java --version
