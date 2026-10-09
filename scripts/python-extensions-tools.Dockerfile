FROM public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS node
FROM public.ecr.aws/docker/library/python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY .checktrail/python-extension-tools/ /usr/local/lib/python3.12/site-packages/
RUN ln -s /usr/local/lib/python3.12/site-packages/bin/ruff /usr/local/bin/ruff
ENV PYTHONDONTWRITEBYTECODE=1
RUN python3 -I -c "from importlib.metadata import version; assert version('mypy') == '2.3.1'; assert version('pytest') == '9.1.1'; assert version('ruff') == '0.16.8'" && node --version
