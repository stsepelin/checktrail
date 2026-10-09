FROM public.ecr.aws/docker/library/eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY spotbugs-4.10.4.tgz /opt/checktrail/spotbugs-4.10.4.tgz
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN echo "72bc0d4edd686e462c0f71f42a049b27bf4da6708797ff7b2b56dd202714b4e5  /opt/checktrail/spotbugs-4.10.4.tgz" | sha256sum -c -
RUN java --version
