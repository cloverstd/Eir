#!/usr/bin/env python3
"""Destructive lifecycle regression on isolated PostgreSQL + MQTT only.

Uses a synthetic MQTT collector; this does not validate ESP32 NVS, flash, or BLE.
"""
import hashlib
import json
import time
import uuid
from lifecycle_support import api, compose, count, eventually, pub, record, sql, verify_isolation, wait_ready

verify_isolation()
wait_ready()


class Collector:
    def __init__(self, identity):
        self.id = identity
        self.nonce = uuid.uuid4().hex
        self.scope = {}

    def status(self, **extra):
        value = dict(protocol_version=2, enrollment_nonce=self.nonce, online=True, firmware='lifecycle-simulator', queue_depth=0, bound=bool(self.scope), **self.scope)
        value.update(extra)
        pub(self.id, 'status', value)

    def claim(self):
        self.status()
        eventually(lambda: any(c['id'] == self.id for c in api('collectors/discovered')), 'Collector not discovered')
        api(f'collectors/{self.id}/bind', {'name': self.id, 'location': 'isolated test', 'enrollment_nonce': self.nonce})
        value = compose('exec', '-T', 'mosquitto', 'mosquitto_sub', '-h', '127.0.0.1', '-q', '1',
            '-t', f'eir/v1/collectors/{self.id}/config', '-C', '1', '-W', '10', capture_output=True, text=True).stdout
        config = json.loads(value)
        self.scope = {k: config[k] for k in ('instance_id', 'binding_id', 'data_epoch')}
        assert config['enrollment_nonce'] == self.nonce
        self.status()
        eventually(lambda: any(x['id'] == self.id and x.get('lifecycle_state') == 'bound' for x in api('collectors')), 'Claim handshake did not finish')
        return config

    def event(self, command, state, data=None, kind=None, error=''):
        pub(self.id, 'events', dict(protocol_version=2, enrollment_nonce=self.nonce, **self.scope,
            command_id=command['id'], type=kind or command['type'], status=state, data=data or {}, error=error))

    def send(self, device, raw, slot=1):
        message = dict(version=2, protocol_version=2, message_id=str(uuid.uuid4()), collector_id=self.id,
            device_id=device, profile='omron-hem-7374t1', user_slot=slot, raw_hex=raw, **self.scope)
        pub(self.id, 'measurements', message)
        return message


def command_for(collector, kind=None):
    # Read only synthetic test commands; mirrors the durable device command receiver.
    rows = json.loads(sql("SELECT coalesce(jsonb_agg(t.payload ORDER BY o.created_at),'[]') FROM operation_targets t JOIN operations o ON o.id=t.operation_id WHERE t.collector_id='" + collector.id + "'"))
    candidates = [r for r in rows if kind is None or r['type'] == kind]
    return candidates[-1] if candidates else None


def baseline(c, command, device, raw=None):
    records = [] if raw is None else [{'user_slot': 1, 'hash': hashlib.sha256(bytes.fromhex(raw)).hexdigest()}]
    c.event(command, 'running', {'device_id': device, 'chunk_index': 0, 'total_chunks': 1, 'records': records}, kind='baseline_chunk')
    c.event(command, 'prepared', {'devices': [device]})


c = Collector('lifecycle-test-a')
c.status()
eventually(lambda: any(x['id'] == c.id for x in api('collectors/discovered')), 'Unbound collector was not discovered')
assert not any(x['id'] == c.id for x in api('collectors')), 'Heartbeat automatically bound a collector'
# Events and measurements from a never-bound collector cannot create a bound record.
c.event({'id': str(uuid.uuid4()), 'type': 'scan'}, 'succeeded')
c.send(str(uuid.uuid4()), record(1))
time.sleep(0.5)
assert not any(x['id'] == c.id for x in api('collectors'))
assert count() == 0
print('PASS discovery does not bind or ingest')

c.claim()
assert any(x['id'] == c.id for x in api('collectors'))
old_scope = dict(c.scope)
old_nonce = c.nonce
api(f'collectors/{c.id}', method='DELETE')
c.status()
c.event({'id': str(uuid.uuid4()), 'type': 'scan'}, 'succeeded')
c.send(str(uuid.uuid4()), record(2))
time.sleep(0.5)
assert not any(x['id'] == c.id for x in api('collectors'))
assert count() == 0
assert count('rejected_messages') == 0, 'Stale health data was persisted in rejection diagnostics'
print('PASS delete then stale heartbeat/event/measurement cannot restore binding')

# Reflash gives the same hardware ID a fresh enrollment request.
c.nonce = uuid.uuid4().hex
c.scope = {}
c.claim()
assert c.scope['binding_id'] != old_scope['binding_id']
pub(c.id, 'status', dict(protocol_version=2, enrollment_nonce=old_nonce, online=True, bound=True, **old_scope))
time.sleep(0.3)
assert any(x['id'] == c.id and x.get('lifecycle_state') == 'bound' for x in api('collectors')), 'Old heartbeat sabotaged a new binding'
print('PASS same hardware identity can be explicitly rebound with new enrollment request')

# Device attachment runs a two-phase baseline before it becomes active.
device = api('devices', {'name': 'Lifecycle meter', 'collector_id': c.id,
    'address': 'AA:BB:CC:DD:EE:71', 'address_type': 0, 'model': 'HEM-7374T1', 'profile': 'omron-hem-7374t1'})['id']
prepare = eventually(lambda: command_for(c, 'device_bind'), 'No device baseline command')
old_record = record(10)
c.event(prepare, 'running', {'device_id': device, 'chunk_index': 0, 'total_chunks': 1}, kind='baseline_chunk')
c.event(prepare, 'prepared', {'devices': [device]})
time.sleep(0.3)
assert any(d['id'] == device and d['lifecycle_state'] == 'pending_baseline' for d in api('devices')), 'Missing baseline records was incorrectly accepted as empty'
baseline(c, prepare, device, old_record)
commit = eventually(lambda: (v if (v := command_for(c, 'device_bind')) and v.get('phase') == 'commit' else None), 'No baseline commit')
c.event(commit, 'succeeded', {'devices': [device]})
eventually(lambda: any(d['id'] == device and d['lifecycle_state'] == 'active' for d in api('devices')), 'Device not active after commit')
c.send(device, old_record)
time.sleep(0.5)
assert count() == 0, 'Baseline record unexpectedly ingested'
# An earlier calendar date with new record content must still be accepted.
fresh = c.send(device, record(11, year=2025))
eventually(lambda: count() == 1, 'Clock rollback/new content record was incorrectly suppressed')
print('PASS baseline blocks old content while accepting new record after clock rollback')

member = api('members', {'name': 'Lifecycle test member'})['id']
binding = api('bindings', {'device_id': device, 'user_slot': 1, 'member_id': member, 'claim_history': True})
api(f"bindings/{binding['id']}/unbind", {})
assert api('measurements')['items'][0]['member_id'] == member
c.send(device, record(12, year=2027))
eventually(lambda: count() == 2, 'Post-unbind record not received')
assert any(r['record_sequence'] == 12 for r in api('measurements?unassigned=true')['items'])
api('bindings', {'device_id': device, 'user_slot': 1, 'member_id': member, 'claim_history': False})
assert any(r['record_sequence'] == 12 and r['member_id'] == member for r in api('measurements')['items'])
api(f"bindings/{binding['id']}/unbind", {})
assert any(r['record_sequence'] == 12 and r['member_id'] == member for r in api('measurements')['items']), 'Repeating closed binding unbind changed newer member association'
print('PASS member unbind history, unassigned records, and repeated old unbind after rebinding')

# Failed preparation may not delete any data.
c.status()
preview = api('operations/preview', {'type': 'system_reset', 'scope': 'measurements'})
assert not preview.get('blockers'), preview
reset_body = {'preview_token': preview['preview_token'], 'confirmation': 'RESET', 'scope': 'measurements'}
op = api('system/reset', reset_body)
reset_prepare = eventually(lambda: command_for(c, 'prepare_data_reset'), 'No reset preparation command')
c.event(reset_prepare, 'failed', error='synthetic sleeping blood pressure monitor')
time.sleep(0.5)
abort = command_for(c, 'abort_data_reset')
if abort:
    c.event(abort, 'succeeded')
    time.sleep(0.3)
assert count() == 2, 'Failed preparation deleted health data'
print('PASS failed reset preparation leaves health data intact')

# Successful prepare/commit persists across app restart and duplicate events.
c.status()
preview = api('operations/preview', {'type': 'system_reset', 'scope': 'measurements'})
reset_body = {'preview_token': preview['preview_token'], 'confirmation': 'RESET', 'scope': 'measurements'}
op = api('system/reset', reset_body)
new_prepare = eventually(lambda: (v if (v := command_for(c, 'prepare_data_reset')) and v['id'] != reset_prepare['id'] else None), 'No new reset preparation')
baseline(c, new_prepare, device, record(12, year=2027))
reset_commit = eventually(lambda: command_for(c, 'commit_data_reset'), 'No reset commit')
assert count() == 0
compose('restart', 'eir', capture_output=True)
wait_ready()
assert command_for(c, 'commit_data_reset')['id'] == reset_commit['id']
c.scope['data_epoch'] = reset_commit['next_data_epoch']
c.event(reset_commit, 'succeeded', {'devices': [device]})
c.event(reset_commit, 'succeeded', {'devices': [device]})
c.status()
eventually(lambda: any(d['id'] == device and d['lifecycle_state'] == 'active' for d in api('devices')), 'Device not active after reset')
c.send(device, record(13, year=2027))
eventually(lambda: count() == 1, 'New epoch record not received')
api('system/reset', reset_body)
assert count() == 1, 'Repeated confirmation cleared newly arrived data'
before_rejections = count('rejected_messages')
pub(c.id, 'measurements', fresh)
time.sleep(0.5)
assert count() == 1 and count('rejected_messages') == before_rejections
print('PASS reset commit restart/replay/idempotency and stale epoch isolation')

# Move one meter between collectors without losing its history.
other = Collector('lifecycle-test-b')
other.claim()
c.status()
api(f'devices/{device}/unbind', {})
unbind_command = eventually(lambda: command_for(c, 'device_unbind'), 'No device unbind command')
c.event(unbind_command, 'succeeded', {'devices': [device]})
eventually(lambda: any(d['id'] == device and not d.get('collector_id') for d in api('devices')), 'Meter did not detach')
assert count() == 1
api(f'devices/{device}/bind', {'collector_id': other.id})
move_prepare = eventually(lambda: command_for(other, 'device_bind'), 'No reassignment baseline')
baseline(other, move_prepare, device, record(13, year=2027))
move_commit = eventually(lambda: (v if (v := command_for(other, 'device_bind')) and v.get('phase') == 'commit' else None), 'No reassignment commit')
other.event(move_commit, 'succeeded', {'devices': [device]})
eventually(lambda: any(d['id'] == device and d['lifecycle_state'] == 'active' and d['collector_id'] == other.id for d in api('devices')), 'Reassigned meter not active')
c.send(device, record(14, year=2027))
time.sleep(0.3)
assert count() == 1
other.send(device, record(14, year=2027))
eventually(lambda: count() == 2, 'New owner could not ingest')
print('PASS meter unbind/reassignment preserves history and enforces owner')

# Device deletion retains historical source visibility and does not remove other collectors.
api(f'collectors/{c.id}', method='DELETE')
assert count() == 2
assert all(r['device_name'] == 'Lifecycle meter' for r in api('measurements')['items'])
assert any(r['collector_id'] == c.id for r in api('measurements')['items'])
assert any(x['id'] == other.id for x in api('collectors'))
c.nonce = uuid.uuid4().hex
c.scope = {}
c.claim()
print('PASS deletion retains readable measurement history')

# Full reset is allowed even while collectors are offline; replay must not revive them.
c.status(online=False)
other.status(online=False)
preview = api('operations/preview', {'type': 'system_reset', 'scope': 'all'})
assert not preview.get('blockers'), preview
body = {'preview_token': preview['preview_token'], 'confirmation': 'RESET', 'scope': 'all'}
api('system/reset', {**body, 'confirmation': 'not-confirmed'}, expected=400)
assert count() == 2, 'Invalid confirmation changed data'
reset = api('system/reset', body)
repeat = api('system/reset', body)
assert reset.get('operation_id', reset.get('id')) == repeat.get('operation_id', repeat.get('id'))
c.status()
c.send(str(uuid.uuid4()), record(3))
time.sleep(0.5)
assert not api('collectors')
assert count() == 0
assert count('rejected_messages') == 0
print('PASS full reset is idempotent and rejects stale messages without persisting health data')
# Server-side terminal states for unbind, runtime reset, and factory reprovisioning.
for kind in ('collector_unbind', 'collector_reset', 'factory_reset'):
    c.nonce = uuid.uuid4().hex
    c.scope = {}
    c.claim()
    if kind == 'collector_reset':
        c.status(online=False)
        eventually(lambda: any(x['id'] == c.id and not x['online'] for x in api('collectors')), 'Offline heartbeat not observed')
        blocked = api('operations/preview', {'type': kind, 'collector_id': c.id})
        assert blocked.get('blockers'), 'Offline reset preview was not blocked'
        api(f'collectors/{c.id}/reset', {'preview_token': blocked['preview_token'], 'confirmation': 'RESET', 'mode': 'runtime'}, expected=400)
        c.status()
        eventually(lambda: any(x['id'] == c.id and x['online'] for x in api('collectors')), 'Online heartbeat not observed')
    if kind == 'collector_unbind':
        result = api(f'collectors/{c.id}/unbind', {})
    else:
        p = api('operations/preview', {'type': kind, 'collector_id': c.id})
        assert not p.get('blockers'), p
        assert p['counts']['members'] == 0 and p['counts']['measurements'] == 0, 'Collector reset preview claims unrelated health deletion'
        result = api(f'collectors/{c.id}/reset', {'preview_token': p['preview_token'], 'confirmation': 'RESET', 'mode': 'factory' if kind == 'factory_reset' else 'runtime'})
    command = eventually(lambda: command_for(c, kind), 'No ' + kind + ' command')
    state = 'awaiting_provisioning' if kind == 'factory_reset' else 'succeeded'
    receipt = dict(command_id=command['id'], type=kind, status=state, **c.scope)
    c.event(command, state, {'local_cleared': True})
    eventually(lambda: not any(x['id'] == c.id for x in api('collectors')), kind + ' did not remove managed collector')
    if kind == 'factory_reset':
        c.nonce = uuid.uuid4().hex
        c.scope = {}
        c.status(reset_receipt=receipt)
        eventually(lambda: any(o['id'] == command['id'] and o['status'] == 'succeeded' for o in api('operations')), 'Factory reprovisioning receipt not recognized')
print('PASS simulated collector unbind/runtime reset/factory reprovisioning completion')
print('LIFECYCLE INTEGRATION TESTS PASSED (synthetic collector; no BLE hardware claim)')
