#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="eir-test-${$}"
export POSTGRES_PASSWORD=eir_isolated_test_only
export MQTT_URL=tcp://mosquitto:1883
export MQTT_PREFIX=eir/v1
export EIR_PUBLIC_URL=http://localhost:18080
export EIR_BIND_ADDRESS=127.0.0.1
export EIR_PORT=${EIR_TEST_PORT:-18082}
export EIR_IMAGE="${EIR_TEST_IMAGE:-eir-test:${$}}"
export COMPOSE_FILE=compose.yaml:compose.test.yaml
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    log_file="${TMPDIR:-/tmp}/$COMPOSE_PROJECT_NAME.log"
    docker compose logs --no-color --tail=100 > "$log_file" 2>&1 || true
    echo "Integration failed; container logs: $log_file" >&2
  fi
  if [ "${EIR_TEST_KEEP:-0}" = 1 ]; then
    echo "Retained test project: $COMPOSE_PROJECT_NAME (image $EIR_IMAGE)"
  else
    docker compose down --volumes --remove-orphans
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
docker info > /dev/null
if [ "${EIR_TEST_SKIP_BUILD:-0}" = 1 ]; then
  docker compose up -d --no-build --wait
else
  docker compose up -d --build --wait
fi
python3 -u scripts/lifecycle_integration.py
