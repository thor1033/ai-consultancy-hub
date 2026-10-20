#!/bin/bash
# Claude Code on the web: make typecheck, build and the verify:* suites runnable.
# The suites need Postgres with pgvector, so this provisions a local throwaway
# database and points DATABASE_URL at it — never at production.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install --no-audit --no-fund --no-save

PG_VERSION=16
if [ ! -f "/usr/share/postgresql/${PG_VERSION}/extension/vector.control" ]; then
  apt-get update -q
  apt-get install -y -q "postgresql-${PG_VERSION}-pgvector"
fi

if ! pg_lsclusters -h | grep -q "^${PG_VERSION} main"; then
  pg_createcluster "$PG_VERSION" main
fi
pg_ctlcluster "$PG_VERSION" main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -q -h 127.0.0.1 && break
  sleep 0.5
done

psql_admin() { su postgres -c "psql -tAq -c \"$1\""; }
[ "$(psql_admin "select 1 from pg_roles where rolname='hubtest'")" = "1" ] ||
  psql_admin "create user hubtest with password 'hubtest' superuser"
[ "$(psql_admin "select 1 from pg_database where datname='aihub'")" = "1" ] ||
  su postgres -c "createdb -O hubtest aihub"

DB_URL="postgresql://hubtest:hubtest@127.0.0.1:5432/aihub"
psql "$DB_URL" -q -c "create extension if not exists vector"
DATABASE_URL="$DB_URL" npm run migrate -w @ai-hub/db

# The verify scripts load this file. The dummy legacy token keeps the check
# that the deprecated HUB_API_TOKENS map still resolves meaningful.
if [ ! -f apps/web/.env.local ]; then
  {
    echo "DATABASE_URL=${DB_URL}"
    echo "HUB_API_TOKENS='{\"tok-local-test\":{\"id\":\"local-test\",\"roles\":[\"viewer\"]}}'"
  } > apps/web/.env.local
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export DATABASE_URL=${DB_URL}" >> "$CLAUDE_ENV_FILE"
fi
