#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="eir-test-health-${$}"
export COMPOSE_FILE=compose.yaml:compose.test.yaml
export POSTGRES_PASSWORD=eir_isolated_test_only
export MQTT_URL=tcp://mosquitto:1883
export MQTT_PREFIX=eir/v1
export EIR_PUBLIC_URL=http://localhost:18086
export EIR_BIND_ADDRESS=127.0.0.1
export EIR_PORT=${EIR_TEST_PORT:-18086}
export EIR_IMAGE=${EIR_TEST_IMAGE:-eir:health-test}
cleanup() {
 result=$?
 if [ "$result" -ne 0 ]; then docker compose logs --no-color --tail=100 > "${TMPDIR:-/tmp}/$COMPOSE_PROJECT_NAME.log" 2>&1 || true; fi
 if [ "${EIR_TEST_KEEP:-0}" = 1 ]; then echo "Retained isolated project: $COMPOSE_PROJECT_NAME"; else docker compose down --volumes --remove-orphans; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
PYTHONPATH=scripts python3 -c 'from lifecycle_support import verify_isolation; verify_isolation()'
docker compose up -d --no-build --wait
python3 -u scripts/health_integration.py
EIR_MCP_TEST_URL="http://127.0.0.1:$EIR_PORT" go test -race ./internal/server -run TestMCPIntegration -count=1
if [ "${EIR_TEST_BROWSER_QA:-0}" = 1 ]; then
 echo "Browser QA: http://127.0.0.1:$EIR_PORT (remove /tmp/$COMPOSE_PROJECT_NAME.pause to finish)"
 touch "/tmp/$COMPOSE_PROJECT_NAME.pause"
 for n in $(seq 1 600); do [ -f "/tmp/$COMPOSE_PROJECT_NAME.pause" ] || break; sleep 1; done
 rm -f "/tmp/$COMPOSE_PROJECT_NAME.pause"
fi
python3 -u scripts/health_integration.py --finish
