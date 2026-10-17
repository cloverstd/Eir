#!/usr/bin/env python3
"""Real DB + MQTT regression checks; only run via integration.sh's isolated project."""
import json, os, subprocess, time, urllib.request, urllib.parse, urllib.error, uuid, csv, io, struct, tempfile, pathlib, shutil, datetime, re

BASE = 'http://127.0.0.1:' + os.environ.get('EIR_PORT', '18080')
PROJECT = os.environ.get('COMPOSE_PROJECT_NAME', '')
assert PROJECT.startswith('eir-test-'), 'Refusing to test a non-isolated compose project'
PREFIX = os.environ.get('MQTT_PREFIX', 'eir/v1')


def compose(*args, **kwargs):
    return subprocess.run(['docker', 'compose', *args], check=True, **kwargs)


def api(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + '/api/v1/' + path, data=data,
        headers={'Content-Type': 'application/json'}, method=method or ('POST' if body is not None else 'GET'))
    try:
        with urllib.request.urlopen(request, timeout=15) as result:
            return json.load(result)
    except urllib.error.HTTPError as error:
        raise AssertionError(f"{request.method} {path}: HTTP {error.code}: {error.read().decode()}") from error


def sql(query):
    return compose('exec', '-T', 'postgres', 'psql', '-U', 'eir', '-d', 'eir', '-At', '-c', query,
                   capture_output=True, text=True).stdout.strip()


def pub(collector, suffix, payload):
    compose('exec', '-T', 'mosquitto', 'mosquitto_pub', '-h', '127.0.0.1', '-q', '1',
            '-t', f'{PREFIX}/collectors/{collector}/{suffix}', '-m', json.dumps(payload), capture_output=True)


def send(payload, expected='stored', timeout=12):
    collector = payload['collector_id']
    sub = subprocess.Popen(['docker', 'compose', 'exec', '-T', 'mosquitto', 'mosquitto_sub',
                            '-h', '127.0.0.1', '-q', '1', '-t', f'{PREFIX}/collectors/{collector}/acks',
                            '-C', '1', '-W', str(timeout)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        time.sleep(0.4)  # subscriber is established before publishing
        pub(collector, 'measurements', payload)
        deadline = time.monotonic() + timeout + 5
        while True:
            try:
                out, err = sub.communicate(timeout=min(1, max(0.1, deadline - time.monotonic())))
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    raise AssertionError('MQTT subscriber did not finish')
                if expected is not None:
                    # Act like the durable ESP32 sender: an absent app ACK causes replay.
                    pub(collector, 'measurements', payload)
        if expected is None:
            assert not out.strip(), f'Unexpected ACK while database unavailable: {out}'
            return
        assert sub.returncode == 0, f'No ACK: {err}'
        ack = json.loads(out)
        assert ack['message_id'] == payload['message_id'], ack
        assert ack['status'] == expected, ack
        return ack
    finally:
        if sub.poll() is None:
            sub.kill()
            sub.wait()


def envelope(device, raw, slot=1, collector='test-living', message=None):
    return dict(version=1, message_id=message or str(uuid.uuid4()), collector_id=collector,
                device_id=device, profile='omron-hem-7374t1', user_slot=slot, raw_hex=raw)


def record(year, month, day, sequence):
    # Synthetic boundary fixture, explicitly not a replacement for real BLE evidence.
    raw = bytearray(16)
    raw[:4] = bytes([86, 69, 90, year - 2000])
    struct.pack_into('<H', raw, 4, month << 10 | day << 5 | 10)
    struct.pack_into('<H', raw, 6, 0)
    struct.pack_into('<H', raw, 10, sequence)
    return raw.hex()


# Seed pre-upgrade identities in the isolated DB to exercise legacy migration compatibility.
# New unrecognized heartbeats must not create bound collectors.
sql("INSERT INTO collectors(id) VALUES('test-living'),('test-bedroom') ON CONFLICT DO NOTHING")
pub('test-living', 'status', {'online': True, 'firmware': 'integration', 'queue_depth': 0})
pub('test-bedroom', 'status', {'online': True, 'firmware': 'integration', 'queue_depth': 0})
for _ in range(30):
    pub('test-living', 'status', {'online': True, 'firmware': 'integration', 'queue_depth': 0})
    pub('test-bedroom', 'status', {'online': True, 'firmware': 'integration', 'queue_depth': 0})
    if len(api('collectors')) >= 2:
        break
    time.sleep(0.3)
else:
    raise AssertionError('MQTT status did not register collectors')
member1 = api('members', {'name': '集成测试甲', 'notes': ''})['id']
member2 = api('members', {'name': '集成测试乙', 'notes': ''})['id']
device = sql("INSERT INTO devices(name,collector_id,address) VALUES('测试血压计','test-living','AA:BB:CC:DD:EE:01') RETURNING id").splitlines()[0]
# Generated synthetic packet; contains no original patient data.
payload = envelope(device, record(2026, 10, 17, 11))
ack1 = send(payload)
ack2 = send(payload)
assert ack1['measurement_id'] == ack2['measurement_id'], 'Duplicate message produced different ID'
ack3 = send({**payload, 'message_id': str(uuid.uuid4())})
assert ack1['measurement_id'] == ack3['measurement_id'], 'Repeated BLE record was not deduplicated'
assert sql('SELECT count(*) FROM measurements') == '1'
rows = api('measurements')['items']
assert (rows[0]['systolic'], rows[0]['diastolic'], rows[0]['pulse']) == (111, 69, 90), rows
print('PASS committed ACK and duplicate message/record deduplication')

# A second assigned device may legitimately contain identical raw record bytes.
device2 = sql("INSERT INTO devices(name,collector_id,address) VALUES('第二台测试血压计','test-bedroom','AA:BB:CC:DD:EE:02') RETURNING id").splitlines()[0]
second_ack = send(envelope(device2, payload['raw_hex'], collector='test-bedroom'))
assert second_ack['measurement_id'] != ack1['measurement_id']
assert sql('SELECT count(*) FROM measurements') == '2'
send({**payload, 'raw_hex': record(2026, 10, 15, 199)}, 'rejected')
rejections_before = int(sql('SELECT count(*) FROM rejected_messages'))
compose('exec', '-T', 'mosquitto', 'mosquitto_pub', '-h', '127.0.0.1', '-q', '1',
        '-t', f'{PREFIX}/collectors/test-living/measurements', '-s', input=b'\xffnot-json', capture_output=True)
for _ in range(30):
    if int(sql('SELECT count(*) FROM rejected_messages')) > rejections_before:
        break
    time.sleep(0.2)
else:
    raise AssertionError('Malformed binary MQTT payload was not persisted')
assert api('rejections'), 'Malformed UTF-8 made the rejection API unreadable'
print('PASS two assigned collectors/devices, reused ID rejection and binary payload persistence')

initial_binding = api('bindings', {'device_id': device, 'user_slot': 1, 'member_id': member1, 'claim_history': True})
initial_time = initial_binding['effective_from']
assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', initial_time), initial_time
assert datetime.datetime.fromisoformat(initial_time.replace('Z', '+00:00')).year == 1
javascript = 'const s=process.argv[1]; if(!Number.isFinite(Date.parse(s)))process.exit(1); console.log(new Date(s).toISOString())'
node = shutil.which('node')
node_command = [node, '-e', javascript, initial_time] if node else ['docker', 'run', '--rm', '--network', 'none', 'node:24-alpine', 'node', '-e', javascript, initial_time]
parsed = subprocess.run(node_command, check=True, capture_output=True, text=True).stdout.strip()
assert parsed == '0001-01-01T00:00:00.000Z', parsed
print('PASS first-history binding is RFC3339 and parses correctly in JavaScript')
assert next(row for row in api('measurements')['items'] if row['id'] == ack1['measurement_id'])['member_id'] == member1
api('bindings', {'device_id': device, 'user_slot': 1, 'member_id': member2,
                 'effective_from': '2026-10-16T00:00:00+08:00', 'claim_history': False})
send(envelope(device, record(2026, 10, 15, 100)))
send(envelope(device, record(2026, 10, 19, 101)))
rows = {row['record_sequence']: row for row in api('measurements')['items']}
assert rows[100]['member_id'] == member1 and rows[101]['member_id'] == member2, rows
send(envelope(device, record(2026, 10, 19, 102), slot=2))
assert any(row['user_slot'] == 2 for row in api('measurements?unassigned=true')['items'])
wrong_owner = envelope(device, record(2026, 10, 19, 103), collector='test-bedroom')
send(wrong_owner, 'rejected')
send(envelope(device, 'ff'), 'rejected')
assert int(sql('SELECT count(*) FROM rejected_messages')) >= 2
print('PASS historical binding, delayed records, unassigned slot and wrong collector rejection')

measurement = rows[100]['id']
api('measurements/' + measurement, {'member_id': member2, 'notes': '=formula-safe note'}, method='PATCH')
assert int(sql('SELECT count(*) FROM measurement_audit')) >= 1
query = urllib.parse.urlencode({'member_id': member2})
with urllib.request.urlopen(BASE + '/api/v1/measurements/export.csv?' + query) as response:
    exported = list(csv.reader(io.StringIO(response.read().decode('utf-8-sig'))))
assert len(exported) == 4, exported
assert api('statistics?' + query)['count'] == 3
print('PASS manual audit, member filtering, statistics and filtered CSV')

outage = envelope(device, record(2026, 10, 20, 104))
compose('stop', 'postgres', stdout=subprocess.DEVNULL)
try:
    send(outage, expected=None, timeout=4)
finally:
    compose('up', '-d', '--wait', 'postgres', stdout=subprocess.DEVNULL)
send(outage)
assert sql('SELECT count(*) FROM measurements WHERE record_sequence=104') == '1'
print('PASS database outage produces no success ACK; replay succeeds after recovery')
compose('restart', 'eir', stdout=subprocess.DEVNULL)
for _ in range(40):
    try:
        with urllib.request.urlopen(BASE + '/readyz', timeout=2):
            break
    except Exception:
        time.sleep(0.5)
else:
    raise AssertionError('Eir did not become ready after restart')
send(outage)
assert sql('SELECT count(*) FROM measurements WHERE record_sequence=104') == '1'
print('PASS committed receipt survives application restart')
# Exercise the actual maintenance scripts against this isolated project.
count_before = sql('SELECT count(*) FROM measurements')
with tempfile.TemporaryDirectory(prefix='eir-backup-test-') as temp:
    destination = str(pathlib.Path(temp) / 'snapshot')
    subprocess.run(['./scripts/backup.sh', destination], check=True)
    subprocess.run(['./scripts/restore.sh', destination, '--replace-database'], check=True)
    assert sql('SELECT count(*) FROM measurements') == count_before
    send(outage)
    assert sql('SELECT count(*) FROM measurements') == count_before
print('PASS actual backup/restore scripts preserve records and idempotency receipts')
print('ALL INTEGRATION TESTS PASSED (does not validate ESP32/BLE hardware)')

# Optional bounded browser QA window. A caller creates this project-specific marker
# before tests finish and removes it when browser checks are complete.
pause_file = pathlib.Path(tempfile.gettempdir()) / (PROJECT + '.pause')
if os.environ.get('EIR_TEST_BROWSER_QA') == '1':
    pause_file.touch()
if pause_file.exists():
    print('BROWSER QA READY: ' + BASE + ' ; remove ' + str(pause_file) + ' to release cleanup', flush=True)
    deadline = time.monotonic() + 600
    while pause_file.exists() and time.monotonic() < deadline:
        time.sleep(1)
    pause_file.unlink(missing_ok=True)
