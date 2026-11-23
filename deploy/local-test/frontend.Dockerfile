ARG BASE_IMAGE=fishroom-frontend:6097405bff30
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG LOCAL_TEST_RELEASE_REVISION
ARG LOCAL_TEST_RELEASE_BUILT_AT
ARG LOCAL_TEST_BASE_REVISION=906eafc
RUN test -n "$LOCAL_TEST_RELEASE_REVISION" && test -n "$LOCAL_TEST_RELEASE_BUILT_AT" && test -n "$LOCAL_TEST_BASE_REVISION"
LABEL org.opencontainers.image.title="Fishroom Local Test Frontend" \
      org.opencontainers.image.revision="$LOCAL_TEST_RELEASE_REVISION" \
      org.opencontainers.image.created="$LOCAL_TEST_RELEASE_BUILT_AT" \
      org.opencontainers.image.base.name="$BASE_IMAGE" \
      io.fishroom.source-base-revision="$LOCAL_TEST_BASE_REVISION" \
      io.fishroom.local-test="true"

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=80 BACKEND_URL=http://backend:8787
ENV RELEASE_REVISION=$LOCAL_TEST_RELEASE_REVISION RELEASE_BUILT_AT=$LOCAL_TEST_RELEASE_BUILT_AT BASE_REVISION=$LOCAL_TEST_BASE_REVISION

# dist must be freshly built on this machine before this image is assembled.
RUN rm -rf /app/server /app/dist
COPY dist/ ./dist/
COPY deploy/frontend-server.mjs ./frontend-server.mjs
COPY deploy/local-test/mark-local-test-html.mjs /tmp/mark-local-test-html.mjs
RUN node /tmp/mark-local-test-html.mjs /app/dist/index.html && rm /tmp/mark-local-test-html.mjs

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 80) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "frontend-server.mjs"]
