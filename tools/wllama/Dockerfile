ARG NODE_IMAGE
ARG EMSDK_IMAGE
FROM ${NODE_IMAGE} AS node
FROM ${EMSDK_IMAGE}
COPY --from=node /usr/local/ /opt/plamo-node/
ENV PATH="/opt/plamo-node/bin:${PATH}"
# OS パッケージを更新せず、digest で固定したイメージ内の道具だけを使う。
RUN git --version && cmake --version && python3 --version && node --version && npm --version
ENTRYPOINT ["node", "/recipe/container-build.mjs"]
