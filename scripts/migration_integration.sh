#!/bin/sh
# Rehearse a v1 backup migration without using the original database or broker.
set -eu
cd "$(dirname "$0")/.."
backup=${1:?Usage: migration_integration.sh /absolute/path/database.dump}
[ -f "$backup" ] || { echo 'Backup file missing' >&2; exit 1; }
export COMPOSE_PROJECT_NAME="eir-test-migration-${$}"
export COMPOSE_FILE=compose.yaml:compose.test.yaml
export POSTGRES_PASSWORD=eir_isolated_test_only
export MQTT_URL=tcp://mosquitto:1883
export MQTT_PREFIX=eir/v1
export EIR_PUBLIC_URL=http://localhost:18084
export EIR_BIND_ADDRESS=127.0.0.1
export EIR_PORT=${EIR_TEST_PORT:-18084}
export EIR_IMAGE=${EIR_TEST_IMAGE:-eir:lifecycle-final}
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    docker compose logs --no-color --tail=80 > "${TMPDIR:-/tmp}/$COMPOSE_PROJECT_NAME.log" 2>&1 || true
  fi
  docker compose down --volumes --remove-orphans
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
PYTHONPATH=scripts python3 -c 'from lifecycle_support import verify_isolation; verify_isolation()'
docker compose up -d --no-build --wait postgres mosquitto
# The image's bootstrap server accepts Unix-socket probes before shutting down.
# Require the final TCP listener before restoring the backup.
docker compose exec -T postgres sh -c 'for n in $(seq 1 30); do pg_isready -h 127.0.0.1 -U eir -d eir >/dev/null && exit 0; sleep 1; done; exit 1'
docker compose exec -T postgres pg_restore -U eir -d eir --no-owner < "$backup"
# Compare precisely the columns present in the backup, including original
# attribution/source fields. New columns in later schemas are not substituted.
columns_before=$(docker compose exec -T postgres psql -U eir -d eir -At -c "SELECT string_agg('m.'||quote_ident(attname),',' ORDER BY attnum) FROM pg_attribute WHERE attrelid='measurements'::regclass AND attnum>0 AND NOT attisdropped")
query_before="SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY id),'empty')) FROM (SELECT $columns_before,b.systolic,b.diastolic,b.pulse FROM measurements m JOIN blood_pressure b ON b.measurement_id=m.id) t"
query_after="$query_before"
# Preserve all association columns that existed before migration as well.
association_queries=""
association_before=""
for table in members collectors devices bindings; do
  columns=$(docker compose exec -T postgres psql -U eir -d eir -At -c "SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) FROM pg_attribute WHERE attrelid='$table'::regclass AND attnum>0 AND NOT attisdropped")
  query="SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY id),'empty')) FROM (SELECT $columns FROM $table) t"
  value=$(docker compose exec -T postgres psql -U eir -d eir -At -c "$query")
  association_before="$association_before$value"
  association_queries="$association_queries$query;"
done
old_schema=$(docker compose exec -T postgres psql -U eir -d eir -At -c 'SELECT max(version) FROM schema_versions')
before=$(docker compose exec -T postgres psql -U eir -d eir -At -c "$query_before")
count_before=$(docker compose exec -T postgres psql -U eir -d eir -At -c 'SELECT count(*) FROM measurements')
old_collectors=$(docker compose exec -T postgres psql -U eir -d eir -At -c 'SELECT count(*) FROM collectors')
docker compose up -d --no-build --wait eir
after=$(docker compose exec -T postgres psql -U eir -d eir -At -c "$query_after")
association_after=$(docker compose exec -T postgres psql -U eir -d eir -At -c "$association_queries" | tr -d '\n')
[ "$association_before" = "$association_after" ] || { echo 'FAIL: member or device association changed' >&2; exit 1; }
[ "$before" = "$after" ] || { echo 'FAIL: migrated measurement identity or value changed' >&2; exit 1; }
count_after=$(docker compose exec -T postgres psql -U eir -d eir -At -c 'SELECT count(*) FROM measurements')
[ "$count_before" = "$count_after" ]
legacy_collectors=$(docker compose exec -T postgres psql -U eir -d eir -At -c "SELECT count(*) FROM collectors WHERE protocol_version=1 AND lifecycle_state='bound'")
if [ "$old_schema" = 1 ]; then
  [ "$old_collectors" = "$legacy_collectors" ] || { echo 'FAIL: legacy collector association changed' >&2; exit 1; }
fi
version=$(docker compose exec -T postgres psql -U eir -d eir -At -c 'SELECT max(version) FROM schema_versions')
[ "$version" = 3 ]
printf 'PASS schema %s-to-3 migration preserved all %s measurement row IDs and values; %s legacy collectors\n' "$old_schema" "$count_after" "$legacy_collectors"
