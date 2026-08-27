FROM postgres:17-alpine@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609

ARG RELEASE_REVISION
ARG RELEASE_BUILT_AT
RUN test -n "$RELEASE_REVISION" && test -n "$RELEASE_BUILT_AT"
LABEL org.opencontainers.image.title="Fishroom Management Database" \
      org.opencontainers.image.revision="$RELEASE_REVISION" \
      org.opencontainers.image.created="$RELEASE_BUILT_AT"

COPY deploy/db-init/001-init.sql /docker-entrypoint-initdb.d/001-init.sql
