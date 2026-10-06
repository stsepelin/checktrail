FROM eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY checkstyle-14.3.0-all.jar /opt/checktrail/checkstyle-14.3.0-all.jar
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN echo "754e218ab1fcabb1e1c5f8530e9d3aa37636806c22987bb279dd907a6ee749b2  /opt/checktrail/checkstyle-14.3.0-all.jar" | sha256sum -c -
RUN java --version && java -jar /opt/checktrail/checkstyle-14.3.0-all.jar --version
