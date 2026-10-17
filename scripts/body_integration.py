#!/usr/bin/env python3
"""AFU regression: real test PostgreSQL/MQTT, simulated BLE collector only."""
import json
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from lifecycle_support import api, compose, eventually, pub, sql, verify_isolation, wait_ready, BASE

verify_isolation()
wait_ready()
collector = 'afu-test-collector'
nonce = uuid.uuid4().hex
caps = {'profiles': ['omron-hem-7374t1', 'afu-wl-tz-a1'], 'max_scales': 2, 'max_connections': 3}
pub(collector, 'status', dict(protocol_version=2, enrollment_nonce=nonce, online=True, bound=False, capabilities=caps))
eventually(lambda: any(c['id'] == collector for c in api('collectors/discovered')), 'discovery')
api(f'collectors/{collector}/bind', {'name': '测试采集端', 'enrollment_nonce': nonce})
config = json.loads(compose('exec', '-T', 'mosquitto', 'mosquitto_sub', '-h', '127.0.0.1', '-q', '1', '-t', f'eir/v1/collectors/{collector}/config', '-C', '1', '-W', '10', capture_output=True, text=True).stdout)
scope = {k: config[k] for k in ('instance_id', 'binding_id', 'data_epoch')}
pub(collector, 'status', dict(protocol_version=2, enrollment_nonce=nonce, online=True, bound=True, capabilities=caps, **scope))
eventually(lambda: api('collectors')[0]['lifecycle_state'] == 'bound', 'claim')


def event(op, state, data, kind='device_bind'):
    pub(collector, 'events', dict(protocol_version=2, command_id=op, type=kind, status=state, data=data, **scope))


def device(index):
    d = api('devices', dict(name=f'测试体脂秤 {index}', collector_id=collector, address=f'02:00:00:00:00:{index:02X}', hardware_id=f'03:00:00:00:00:{index:02X}', model='AFU-WL-TZ-A1', profile='afu-wl-tz-a1'))
    op = d['operation_id']
    event(op, 'running', dict(device_id=d['id'], chunk_index=0, total_chunks=1, records=[]), 'baseline_chunk')
    event(op, 'prepared', dict(devices=[d['id']]))
    eventually(lambda: json.loads(sql(f"SELECT payload FROM operation_targets WHERE operation_id='{op}'"))['phase'] == 'commit', 'prepare scale')
    event(op, 'succeeded', dict(devices=[d['id']]))
    eventually(lambda: any(x['id'] == d['id'] and x['lifecycle_state'] == 'active' for x in api('devices')), 'enable scale')
    return d


d1, d2 = device(1), device(2)
before = int(sql('SELECT count(*) FROM devices'))
api('devices', dict(name='超额体脂秤', collector_id=collector, address='02:00:00:00:00:03', hardware_id='03:00:00:00:00:03', model='AFU-WL-TZ-A1', profile='afu-wl-tz-a1'), expected=400)
assert int(sql('SELECT count(*) FROM devices')) == before
# An old firmware cannot receive a scale; failed capability checks add no row.
sql(f"UPDATE collectors SET status=status-'capabilities' WHERE id='{collector}'")
api('devices', dict(name='旧固件秤', collector_id=collector, address='02:00:00:00:00:04', hardware_id='03:00:00:00:00:04', model='AFU-WL-TZ-A1', profile='afu-wl-tz-a1'), expected=400)
sql(f"UPDATE collectors SET status=status||'{json.dumps({'capabilities': caps})}'::jsonb WHERE id='{collector}'")
print('PASS capability and two-scale capacity enforcement')

p1 = api('members', dict(name='测试甲', sex='male', birth_date='1990-01-01', height_cm=170))
p2 = api('members', dict(name='测试乙', sex='female', birth_date='1988-01-01', height_cm=160))
for d, p in ((d1, p1), (d2, p2)):
    api('bindings', dict(device_id=d['id'], user_slot=0, member_id=p['id']))
api('bindings', dict(device_id=d1['id'], user_slot=1, member_id=p1['id']), expected=400)
weight = 'ac298069117002000540000a000000000029d51b'
adc = 'ac29020001f401c20180691170000000000029d60f'
captured = (datetime.now(timezone.utc)-timedelta(hours=1)).isoformat(timespec='seconds')


def send(d, session=None, impedance=None, at=captured, **extra):
    value = dict(version=2, message_id=uuid.uuid4().hex, collector_id=collector, device_id=d['id'], profile='afu-wl-tz-a1', user_slot=0, measurement_session_id=session or uuid.uuid4().hex, captured_at=at, raw_hex=weight, **scope)
    if impedance is not None:
        value['impedance_raw_hex'] = impedance
    value.update(extra)
    pub(collector, 'measurements', value)
    eventually(lambda: int(sql(f"SELECT count(*) FROM receipts WHERE collector_id='{collector}' AND message_id='{value['message_id']}'")) == 1, 'app acknowledgement')
    return value


def records():
    return api('measurements?kind=body_composition&page_size=200')['items']


def by_session(session):
    return next(r for r in records() if r['measurement_session_id'] == session)


# TZ-A1 live frames still have status 02. They must never become a stored
# stable result, even though the original Swift property accepted them.
live = send(d1, raw_hex=weight[:4]+'00'+weight[6:])
assert sql(f"SELECT status FROM receipts WHERE message_id='{live['message_id']}'") == 'rejected'
assert records() == []
print('PASS live D5 rejected before result lock')

m1 = send(d1)
r = by_session(m1['measurement_session_id'])
assert float(r['weight_kg']) == 70.0 and r['member_id'] == p1['id']
assert r['body_fat_pct'] == 0 and r['body_fat_status'] == 'missing_adc'
send(d1, session=m1['measurement_session_id'], impedance=adc)
r = by_session(m1['measurement_session_id'])
assert r['raw_adcs'] == [500, 450] and r['body_fat_status'] == 'estimated' and float(r['body_fat_pct']) > 0
id1, fat1 = r['id'], r['body_fat_pct']
assert int(sql('SELECT count(*) FROM measurements')) == 1
pub(collector, 'measurements', m1)
time.sleep(0.3)
assert len(records()) == 1 and by_session(m1['measurement_session_id'])['id'] == id1
# ADC message may arrive first; a later weight-only message cannot erase it.
m2 = send(d2, impedance=adc)
send(d2, session=m2['measurement_session_id'])
assert by_session(m2['measurement_session_id'])['member_id'] == p2['id']
assert by_session(m2['measurement_session_id'])['body_fat_status'] == 'estimated'
assert by_session(m2['measurement_session_id'])['body_fat_pct'] != fat1
# Same device + identical raw bytes in another load cycle is another record.
send(d1)
assert len(records()) == 3
print('PASS separate scale ownership, equal weights, enrichment, duplicates and out-of-order messages')

# Late data uses the binding at capture, not today's owner.
cutoff = (datetime.now(timezone.utc)-timedelta(minutes=10)).isoformat(timespec='seconds')
api('bindings', dict(device_id=d1['id'], user_slot=0, member_id=p2['id'], effective_from=cutoff))
late = send(d1, impedance=adc)
assert by_session(late['measurement_session_id'])['member_id'] == p1['id']
current = send(d1, impedance=adc, at=datetime.now(timezone.utc).isoformat(timespec='seconds'))
assert by_session(current['measurement_session_id'])['member_id'] == p2['id']
uncalibrated = send(d1, impedance=adc, at='')
assert by_session(uncalibrated['measurement_session_id'])['member_id'] is None
assert by_session(uncalibrated['measurement_session_id'])['measured_at'] is None
assert by_session(uncalibrated['measurement_session_id'])['body_fat_pct'] == 0
assert len(api('measurements?kind=body_composition&unassigned=true')['items']) == 1
# Explicit reassignment recalculates; a later profile edit does not rewrite it.
changed = api('measurements/'+id1, dict(member_id=p2['id']), method='PATCH')
assert changed['body_fat_pct'] != fat1
assert changed['profile_snapshot']['sex'] == 'female'
saved_fat = changed['body_fat_pct']
api('members/'+p2['id'], dict(name='测试乙', height_cm=180), method='PUT')
assert by_session(m1['measurement_session_id'])['body_fat_pct'] == saved_fat
assert next(p for p in api('members') if p['id'] == p2['id'])['sex'] == 'female'
assert int(sql(f"SELECT count(*) FROM measurement_audit WHERE measurement_id='{id1}'")) > 0
print('PASS historical binding, invalid clock, explicit correction and frozen calculation snapshots')

bad = send(d1, impedance=adc.replace('691170', '6911d4'))
assert sql(f"SELECT status FROM receipts WHERE message_id='{bad['message_id']}'") == 'rejected'
bad = send(d1, session=m1['measurement_session_id'], raw_hex=weight.replace('691170', '6911d4'))
assert sql(f"SELECT status FROM receipts WHERE message_id='{bad['message_id']}'") == 'rejected'
assert by_session(m1['measurement_session_id'])['raw_hex'] == weight
# Raw zero ADCs are retained but never enter body-fat statistics.
zero = send(d2, impedance=adc.replace('01f401c2','00000000'))
assert by_session(zero['measurement_session_id'])['body_fat_pct'] == 0
# Preserve pre-fix live readings in the history without presenting them as
# valid health statistics. Only this isolated fixture mutates a raw packet.
legacy = send(d1)
legacy_id = by_session(legacy['measurement_session_id'])['id']
sql(f"UPDATE measurements SET raw_data=decode('{weight[:4]+'00'+weight[6:]}','hex'),parser_version='afu-tz-a1-v1' WHERE id='{legacy_id}'")
assert by_session(legacy['measurement_session_id'])['weight_valid'] is False
stats = api('statistics?kind=body_composition')
assert stats['count'] == sum(bool(r['weight_valid']) and bool(r['measured_at']) for r in records())
estimated = [float(r['body_fat_pct']) for r in records() if r['body_fat_status'] == 'estimated' and r['measured_at']]
assert stats['body_fat_count'] == len(estimated)
assert abs(float(stats['mean_body_fat_pct'])-sum(estimated)/len(estimated)) <= .0051
with urllib.request.urlopen(BASE+'/api/v1/measurements/export.csv?kind=body_composition') as response:
    exported = response.read().decode('utf-8-sig')
assert '估算体脂率' in exported and 'missing_adc' in exported
print('PASS mismatched ADC/session rejection and missing-zero exclusion from statistics/CSV')

before = [(r['id'], r['raw_hex'], r['body_fat_pct']) for r in records()]
compose('restart', 'eir', capture_output=True)
wait_ready()
assert before == [(r['id'], r['raw_hex'], r['body_fat_pct']) for r in records()]
pub(collector, 'measurements', m1)
time.sleep(.3)
assert len(records()) == len(before)
# Stale generation never enters diagnostics or restores a reset record.
rejected_before = int(sql('SELECT count(*) FROM rejected_messages'))
stale = dict(m1, message_id=uuid.uuid4().hex, data_epoch=str(uuid.uuid4()))
pub(collector, 'measurements', stale)
time.sleep(.4)
assert int(sql('SELECT count(*) FROM rejected_messages')) == rejected_before
assert len(records()) == len(before)
print('PASS service restart, replay and stale-generation isolation')
print('AFU integration passed (simulated collectors; physical three-device BLE remains pending)')
