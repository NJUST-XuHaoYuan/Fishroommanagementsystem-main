ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG TEST_RELEASE_REVISION
ARG TEST_RELEASE_BUILT_AT
RUN test -n "$TEST_RELEASE_REVISION" && test -n "$TEST_RELEASE_BUILT_AT"
LABEL org.opencontainers.image.title="Fishroom Cloud Test Frontend" \
      org.opencontainers.image.revision="$TEST_RELEASE_REVISION" \
      org.opencontainers.image.created="$TEST_RELEASE_BUILT_AT" \
      org.opencontainers.image.base.name="$BASE_IMAGE" \
      io.fishroom.cloud-test="true"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=80 BACKEND_URL=http://backend:8787
ENV RELEASE_REVISION=$TEST_RELEASE_REVISION RELEASE_BUILT_AT=$TEST_RELEASE_BUILT_AT
RUN rm -rf /app/server /app/dist
COPY dist/ ./dist/
COPY deploy/frontend-server.mjs ./frontend-server.mjs
COPY deploy/cloud-test/mark-cloud-test-html.mjs /tmp/mark-cloud-test-html.mjs
RUN node /tmp/mark-cloud-test-html.mjs /app/dist/index.html && rm /tmp/mark-cloud-test-html.mjs
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 80) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "frontend-server.mjs"]
