#!/bin/sh
set -eu

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export POSTGRES_DB="${POSTGRES_DB:-fishroom}"
export POSTGRES_USER="${POSTGRES_USER:-fishroom}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-fishroom_local_password}"

mkdir -p "$PGDATA"
mkdir -p /run/postgresql
chown -R postgres:postgres "$PGDATA"
chown -R postgres:postgres /run/postgresql

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL data directory at $PGDATA"
  su-exec postgres initdb -D "$PGDATA" --auth-local=trust --auth-host=scram-sha-256
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = 5432"
  } >> "$PGDATA/postgresql.conf"
fi

echo "Starting PostgreSQL"
su-exec postgres pg_ctl -D "$PGDATA" -w start

su-exec postgres psql --host /run/postgresql --set ON_ERROR_STOP=1 --dbname postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
    CREATE ROLE "${POSTGRES_USER}" LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ELSE
    ALTER ROLE "${POSTGRES_USER}" WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE "${POSTGRES_DB}" OWNER "${POSTGRES_USER}"'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${POSTGRES_DB}')\gexec

GRANT ALL PRIVILEGES ON DATABASE "${POSTGRES_DB}" TO "${POSTGRES_USER}";
SQL

stop_services() {
  if [ -n "${APP_PID:-}" ]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
  su-exec postgres pg_ctl -D "$PGDATA" -m fast -w stop
}

trap 'stop_services; exit 0' INT TERM

echo "Starting Fishroom app"
node server/local-server.mjs &
APP_PID="$!"
wait "$APP_PID"
stop_services
