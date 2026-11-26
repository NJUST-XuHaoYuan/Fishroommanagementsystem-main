ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG TEST_RELEASE_REVISION
ARG TEST_RELEASE_BUILT_AT
RUN test -n "$TEST_RELEASE_REVISION" && test -n "$TEST_RELEASE_BUILT_AT"
LABEL org.opencontainers.image.title="Fishroom Cloud Test Backend" \
      org.opencontainers.image.revision="$TEST_RELEASE_REVISION" \
      org.opencontainers.image.created="$TEST_RELEASE_BUILT_AT" \
      org.opencontainers.image.base.name="$BASE_IMAGE" \
      io.fishroom.cloud-test="true"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
ENV RELEASE_REVISION=$TEST_RELEASE_REVISION RELEASE_BUILT_AT=$TEST_RELEASE_BUILT_AT
ENV FISHROOM_DISABLE_BACKGROUND_TASKS=true FISHROOM_CLOUD_TEST=true
# Reuse only the cached runtime/dependencies; replace all application source.
RUN rm -rf /app/server /app/dist /app/deploy/local-test /app/deploy/cloud-test
COPY server/ ./server/
COPY deploy/local-test/ ./deploy/local-test/
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/local-server.mjs"]
