FROM eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY kotlin-compiler-2.4.10.zip /opt/checktrail/kotlin-compiler-2.4.10.zip
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN echo "473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d  /opt/checktrail/kotlin-compiler-2.4.10.zip" | sha256sum -c -
RUN java --version
