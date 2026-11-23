ARG BASE_IMAGE=fishroom-backend:6097405bff30
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG LOCAL_TEST_RELEASE_REVISION
ARG LOCAL_TEST_RELEASE_BUILT_AT
ARG LOCAL_TEST_BASE_REVISION=906eafc
RUN test -n "$LOCAL_TEST_RELEASE_REVISION" && test -n "$LOCAL_TEST_RELEASE_BUILT_AT" && test -n "$LOCAL_TEST_BASE_REVISION"
LABEL org.opencontainers.image.title="Fishroom Local Test Backend" \
      org.opencontainers.image.revision="$LOCAL_TEST_RELEASE_REVISION" \
      org.opencontainers.image.created="$LOCAL_TEST_RELEASE_BUILT_AT" \
      org.opencontainers.image.base.name="$BASE_IMAGE" \
      io.fishroom.source-base-revision="$LOCAL_TEST_BASE_REVISION" \
      io.fishroom.local-test="true"

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
ENV RELEASE_REVISION=$LOCAL_TEST_RELEASE_REVISION RELEASE_BUILT_AT=$LOCAL_TEST_RELEASE_BUILT_AT BASE_REVISION=$LOCAL_TEST_BASE_REVISION
ENV FISHROOM_DISABLE_BACKGROUND_TASKS=true

# Keep the verified cached runtime and dependencies; replace every old source file.
RUN rm -rf /app/server /app/dist /app/deploy/local-test
COPY server/ ./server/
COPY deploy/local-test/ ./deploy/local-test/

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/local-server.mjs"]
