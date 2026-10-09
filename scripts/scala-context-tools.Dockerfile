FROM public.ecr.aws/docker/library/eclipse-temurin@sha256:541729c21f9308a68cebbe5a0627e4cd465dfe8980fc03bac0b2feaee57daafd AS jdk
FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM public.ecr.aws/docker/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6
# These cached, pinned images supply Git and Node without a package download.
# Keep the Alpine Node binary with its musl and C++ runtime dependencies.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /lib/ld-musl-*.so.1 /lib/
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/
RUN node --version && git --version

COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && npm --version

COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin
RUN java --version && javac --version && node --version && git --version

COPY scala3-3.9.0.zip /opt/checktrail/scala3-3.9.0.zip
RUN echo "2ec08ce51e400090058ad075fff0be764c7e16fb827d299c1be0d053d425770c  /opt/checktrail/scala3-3.9.0.zip" | sha256sum -c -
COPY lib /opt/checktrail/scala/lib
RUN java -Xmx256m -cp '/opt/checktrail/scala/lib/*' dotty.tools.dotc.Main -version
