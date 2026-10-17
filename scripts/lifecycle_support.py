"""Helpers for lifecycle tests. Refuses to touch a non-test Compose project."""
import json
import os
import struct
import subprocess
import time
import urllib.error
import urllib.request
import uuid

PROJECT = os.environ.get('COMPOSE_PROJECT_NAME', '')
if not PROJECT.startswith('eir-test-'):
    raise RuntimeError('Lifecycle tests require an isolated eir-test-* Compose project')
BASE = 'http://127.0.0.1:' + os.environ.get('EIR_PORT', '18080')
PREFIX = os.environ.get('MQTT_PREFIX', 'eir/v1')


def compose(*args, **kwargs):
    return subprocess.run(['docker', 'compose', *args], check=True, **kwargs)


def verify_isolation():
    config = json.loads(compose('config', '--format', 'json', capture_output=True, text=True).stdout)
    assert config['name'] == PROJECT
    assert config['services']['eir']['environment']['MQTT_URL'] == 'tcp://mosquitto:1883', 'Do not use the real MQTT broker'
    assert str(config['services']['eir']['ports'][0]['published']) != '8080', 'Do not use the real Eir port'
    for volume in config['volumes'].values():
        assert volume['name'].startswith(PROJECT + '_'), 'Do not use shared persistent volumes'
        assert not volume.get('external', False)


def api(path, body=None, method=None, expected=(200, 201, 202)):
    request = urllib.request.Request(BASE + '/api/v1/' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'}, method=method or ('POST' if body is not None else 'GET'))
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read().decode()
        allowed = expected if isinstance(expected, tuple) else (expected,)
        assert response.status in allowed, f'{request.method} {path}: {response.status}: {raw}'
        if not raw: return None
        try: return json.loads(raw)
        except json.JSONDecodeError:
            if response.status >= 400: return {'error': raw}
            raise


def sql(query):
    return compose('exec', '-T', 'postgres', 'psql', '-U', 'eir', '-d', 'eir', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query,
                   capture_output=True, text=True).stdout.strip()


def pub(collector, suffix, payload):
    compose('exec', '-T', 'mosquitto', 'mosquitto_pub', '-h', '127.0.0.1', '-q', '1',
        '-t', f'{PREFIX}/collectors/{collector}/{suffix}', '-m', json.dumps(payload), capture_output=True)


def eventually(check, message, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError(message)


def record(sequence, year=2026, month=10, day=17):
    raw = bytearray(16)
    raw[:4] = bytes([86, 69, 90, year - 2000])
    struct.pack_into('<H', raw, 4, month << 10 | day << 5 | 10)
    struct.pack_into('<H', raw, 10, sequence)
    return raw.hex()


def wait_ready():
    def ready():
        try:
            with urllib.request.urlopen(BASE + '/readyz', timeout=2):
                return True
        except (OSError, urllib.error.URLError):
            return False
    eventually(ready, 'Eir did not become ready', timeout=40)


def count(table='measurements'):
    assert table in {'measurements', 'members', 'collectors', 'rejected_messages', 'receipts', 'devices'}
    return int(sql('SELECT count(*) FROM ' + table))
