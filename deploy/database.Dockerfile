FROM postgres:17-alpine

COPY deploy/db-init/001-init.sql /docker-entrypoint-initdb.d/001-init.sql
