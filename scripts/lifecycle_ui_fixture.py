#!/usr/bin/env python3
"""Bounded synthetic collector for browser QA on an isolated test project only.

Touch /tmp/eir-ui-offline to simulate disconnection. Never uses a real broker.
"""
import json
import pathlib
import time
import uuid
from lifecycle_support import api, pub, record, sql, verify_isolation

verify_isolation()
identity = 'ui-test-collector'
nonce = uuid.uuid4().hex
scope = {}
seeded = False
sent = False
meter = None
handled = set()
deadline = time.monotonic() + 900
flag = pathlib.Path('/private/tmp/eir-ui-offline')
flag.unlink(missing_ok=True)
print('Synthetic UI collector ready; will stop automatically after 15 minutes', flush=True)
while time.monotonic() < deadline:
    row = json.loads(sql("SELECT coalesce((SELECT row_to_json(t) FROM (SELECT c.binding_id::text,c.lifecycle_state,s.instance_id::text,s.data_epoch::text FROM collectors c CROSS JOIN system_state s WHERE c.id='ui-test-collector') t),'{}')"))
    if row and row['lifecycle_state'] in ('binding', 'bound') and not scope:
        scope = {key: row[key] for key in ('instance_id', 'binding_id', 'data_epoch')}
    pub(identity, 'status', dict(protocol_version=2, enrollment_nonce=nonce, online=not flag.exists(), firmware='ui-simulator-0.2', queue_depth=0, ip='127.0.0.1', bound=bool(scope), **scope))
    if flag.exists():
        time.sleep(2)
        continue
    if row and row['lifecycle_state'] == 'bound' and not seeded:
        member = api('members', {'name': '浏览器测试成员'})['id']
        meter = api('devices', {'name': '浏览器测试血压计', 'collector_id': identity, 'address': 'AA:BB:CC:DD:EE:88', 'address_type': 0, 'model': 'HEM-7374T1', 'profile': 'omron-hem-7374t1'})['id']
        api('bindings', {'device_id': meter, 'user_slot': 1, 'member_id': member, 'claim_history': True})
        seeded = True
        print('Seeded test member, meter, member binding', flush=True)
    targets = json.loads(sql("SELECT coalesce(jsonb_agg(t.payload),'[]') FROM operation_targets t JOIN operations o ON o.id=t.operation_id WHERE t.collector_id='ui-test-collector' AND o.status IN('pending','preparing','committing')"))
    for command in targets:
        key = (command['id'], command.get('phase'), command['type'])
        if key in handled:
            continue
        event = dict(protocol_version=2, enrollment_nonce=nonce, command_id=command['id'], type=command['type'], **scope)
        if command.get('phase') == 'prepare':
            devices = [d for d in api('devices') if d.get('collector_id') == identity and (not command.get('device_id') or d['id'] == command['device_id'])]
            for d in devices:
                pub(identity, 'events', {**event, 'type': 'baseline_chunk', 'status': 'running', 'data': {'device_id': d['id'], 'chunk_index': 0, 'total_chunks': 1, 'records': []}})
            pub(identity, 'events', {**event, 'status': 'prepared', 'data': {'devices': [d['id'] for d in devices]}})
        else:
            if command.get('next_data_epoch'):
                scope['data_epoch'] = command['next_data_epoch']
                event.update(scope)
            pub(identity, 'events', {**event, 'status': 'succeeded', 'data': {'local_cleared': True}})
            if command['type'] in ('collector_unbind', 'collector_reset'):
                time.sleep(0.3)
                nonce = uuid.uuid4().hex
                scope = {}
        handled.add(key)
    if meter and not sent and any(d['id'] == meter and d['lifecycle_state'] == 'active' for d in api('devices')):
        pub(identity, 'measurements', dict(version=2, protocol_version=2, message_id=str(uuid.uuid4()), collector_id=identity, device_id=meter, profile='omron-hem-7374t1', user_slot=1, raw_hex=record(88), **scope))
        sent = True
        print('Seeded one synthetic measurement', flush=True)
    time.sleep(2)
print('UI simulator stopped at bounded deadline', flush=True)
