#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="eir-test-frontend-${$}"
export COMPOSE_FILE=compose.yaml:compose.test.yaml:compose.frontend-test.yaml
export POSTGRES_PASSWORD=eir_isolated_test_only
export MQTT_URL=tcp://mosquitto:1883
export MQTT_PREFIX=eir/v1
export EIR_PUBLIC_URL=http://localhost:18088
export EIR_BIND_ADDRESS=127.0.0.1
export EIR_PORT=${EIR_TEST_PORT:-18088}
export EIR_TEST_DB_PORT=${EIR_TEST_DB_PORT:-18547}
export EIR_IMAGE=${EIR_TEST_IMAGE:-eir:frontend-test}
cleanup() {
 result=$?
 if [ "$result" -ne 0 ]; then docker compose logs --no-color --tail=100 > "${TMPDIR:-/tmp}/$COMPOSE_PROJECT_NAME.log" 2>&1 || true; fi
 if [ "${EIR_TEST_KEEP:-0}" = 1 ]; then echo "Retained isolated project: $COMPOSE_PROJECT_NAME"; else docker compose down --volumes --remove-orphans; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
PYTHONPATH=scripts python3 -c 'from lifecycle_support import verify_isolation; verify_isolation()'
if [ "${EIR_TEST_SKIP_BUILD:-0}" = 1 ]; then docker compose up -d --no-build --wait; else docker compose up -d --build --wait; fi
EIR_TEST_DATABASE_URL="postgres://eir:$POSTGRES_PASSWORD@127.0.0.1:$EIR_TEST_DB_PORT/eir_test_frontend?sslmode=disable" go test -race ./internal/server ./internal/store -run 'Test(MeasurementViews|ScaleNumberingMigration|WaistObservations|PushEnqueue|PushQueue|OfflineSnapshot)Integration' -count=1 -v
