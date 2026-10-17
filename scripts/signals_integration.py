#!/usr/bin/env python3
"""Real isolated PostgreSQL/MQTT and synthetic radio telemetry, never hardware."""
import json
import time
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timezone
from lifecycle_support import api, compose, eventually, pub, sql, verify_isolation, wait_ready, BASE

verify_isolation()
wait_ready()
collector = 'signals-test-collector'
nonce, boot = uuid.uuid4().hex, uuid.uuid4().hex
pub(collector, 'status', dict(protocol_version=2, enrollment_nonce=nonce, online=True, bound=False))
eventually(lambda: any(c['id'] == collector for c in api('collectors/discovered')), 'candidate')
api(f'collectors/{collector}/bind', dict(name='信号测试 ESP32', enrollment_nonce=nonce))
config = json.loads(compose('exec', '-T', 'mosquitto', 'mosquitto_sub', '-h', '127.0.0.1', '-t', f'eir/v1/collectors/{collector}/config', '-C', '1', '-W', '10', capture_output=True, text=True).stdout)
scope = {k: config[k] for k in ('instance_id', 'binding_id', 'data_epoch')}
status = dict(protocol_version=2, enrollment_nonce=nonce, online=True, bound=True, boot_id=boot, uptime=100, firmware='signals-simulator', capabilities={'signals': True}, **scope)
pub(collector, 'status', status)
eventually(lambda: api('collectors')[0]['lifecycle_state'] == 'bound', 'bound')
member = api('members', dict(name='信号测试成员'))
device = api('devices', dict(name='信号测试血压计', collector_id=collector, address='02:00:00:00:00:51'))
# Lifecycle handshake has its own integration suite. Activate only this fixture.
sql(f"UPDATE devices SET lifecycle_state='active' WHERE id='{device['id']}'")
api('bindings', dict(device_id=device['id'], user_slot=1, member_id=member['id']))

def packet(seq, wifi=-55, ble=-72):
    return dict(protocol_version=2, boot_id=boot, sequence=seq, sent_at=datetime.now(timezone.utc).isoformat(), samples=[
        dict(kind='wifi', source='wifi', age_ms=0, rssi=wifi, connected=wifi is not None),
        dict(kind='ble', device_id=device['id'], source='advertisement', age_ms=200, rssi=ble, connected=False),
    ], **scope)

def latest(): return api(f'signals/latest?collector_id={collector}')
def count(): return int(sql('SELECT count(*) FROM signal_samples'))

# The existing stream emits only the dedicated event for telemetry.
with urllib.request.urlopen(BASE+'/api/v1/events/stream', timeout=5) as stream:
    assert stream.readline() == b'event: change\n'
    stream.readline(); stream.readline()
    p = packet(10)
    pub(collector, 'signals', p)
    assert stream.readline() == b'event: signals\n'
    stream.readline(); stream.readline()
eventually(lambda: len(latest()) == 2, 'latest Wi-Fi and BLE')
assert all(v['fresh'] for v in latest())
pub(collector, 'signals', p)
time.sleep(.3)
assert count() == 2, 'QoS duplicate must not append history'
pub(collector, 'signals', packet(12, -60, -80))
eventually(lambda: all(v['sequence'] == 12 for v in latest()), 'new samples')
pub(collector, 'signals', packet(11, -90, -95))
eventually(lambda: count() == 6, 'out-of-order history')
assert all(v['sequence'] == 12 for v in latest()), 'late sequence overwrote latest'
for key in ('binding_id', 'data_epoch', 'instance_id', 'boot_id'):
    bad = packet(20)
    bad[key] = uuid.uuid4().hex if key == 'boot_id' else str(uuid.uuid4())
    pub(collector, 'signals', bad)
time.sleep(.3)
assert count() == 6, 'old scope or boot accepted'
bad = packet(21); bad['samples'][1]['device_id'] = str(uuid.uuid4())
pub(collector, 'signals', bad)
eventually(lambda: count() == 7, 'foreign device excluded, own Wi-Fi accepted')
assert len(latest()) == 2
pub(collector, 'status', status)
time.sleep(.3)
unclocked=packet(30);unclocked.pop('sent_at');unclocked['uptime_ms']=100000
pub(collector, 'signals', unclocked)
eventually(lambda: all(v['sequence']==30 for v in latest()), 'unclocked sample anchored to heartbeat')
before=count()
replayed=packet(31);replayed.pop('sent_at');replayed['uptime_ms']=50000
pub(collector, 'signals', replayed)
time.sleep(.3)
assert count()==before, 'old unclocked outbox sample became fresh after reconnect'
for kind, suffix in [('wifi', ''), ('ble', '&device_id='+device['id'])]:
    for period, bucket in [('15m', 5), ('1h', 5), ('24h', 60), ('7d', 300)]:
        v = api(f'signals/history?collector_id={collector}&kind={kind}&range={period}{suffix}')
        assert v['bucket_seconds'] == bucket
        assert any(x['count'] > 0 for x in v['items'])
        assert any(x['mean'] is None for x in v['items']), 'outage buckets must stay null'
pub(collector, 'signals', packet(32, None))
eventually(lambda: any(v['kind'] == 'wifi' and v['rssi'] is None for v in latest()), 'unavailable Wi-Fi')
sql("UPDATE signal_samples SET sampled_at=now()-interval '30 seconds'")
assert not any(v['fresh'] for v in latest())
pub(collector, 'status', {'online': False})
eventually(lambda: not any(v['online'] for v in latest()), 'last will offline')
new_boot = uuid.uuid4().hex
pub(collector, 'status', {**status, 'boot_id': new_boot})
time.sleep(.3)
pub(collector, 'signals', packet(23))
time.sleep(.3)
assert not any(v['fresh'] for v in latest()), 'previous boot accepted'
boot = new_boot
pub(collector, 'signals', packet(1))
eventually(lambda: all(v['fresh'] for v in latest()), 'sequence restarts on new boot')
sql(f"UPDATE devices SET lifecycle_state='unbound',collector_id=NULL WHERE id='{device['id']}'")
assert len(latest()) == 1
pub(collector, 'signals', packet(2))
eventually(lambda: any(v['sequence'] == 2 for v in latest()), 'Wi-Fi remains available')
sql("UPDATE signal_samples SET sampled_at=now()-interval '8 days'")
compose('restart', 'eir')
wait_ready()
eventually(lambda: count() == 0, 'startup seven-day retention cleanup')
sql(f"UPDATE devices SET lifecycle_state='active',collector_id='{collector}' WHERE id='{device['id']}'")
pub(collector, 'signals', packet(3))
eventually(lambda: len(latest()) == 2, 'resume after restart')
sql(f"DELETE FROM bindings WHERE device_id='{device['id']}'")
sql(f"DELETE FROM devices WHERE id='{device['id']}'")
assert len(latest()) == 1, 'device deletion must cascade telemetry'
sql(f"DELETE FROM collectors WHERE id='{collector}'")
assert latest() == [] and count() == 0
for path in ('signals/latest?kind=invalid', 'signals/history?kind=ble', 'signals/latest?device_id=bad'):
    api(path, expected=400)
for path, code in [('/members/id/documents', 200), ('/body?page=3', 200), ('/api/v1/missing', 404), ('/assets/missing.js', 404)]:
    try: response = urllib.request.urlopen(BASE+path)
    except urllib.error.HTTPError as error: response = error
    assert response.status == code
print('PASS signal scopes, boots, QoS dedup, order, unclocked replay, unavailable RSSI, SSE isolation, history gaps/aggregation, TTL, cascade, SPA fallback')
