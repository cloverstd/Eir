#!/usr/bin/env python3
"""Bounded AFU simulator for mobile UI QA; isolated eir-test-* projects only."""
import json
import time
import uuid
from datetime import datetime, timezone
from lifecycle_support import api, eventually, pub, sql, verify_isolation

verify_isolation()
identity = 'afu-ui-test'
nonce = uuid.uuid4().hex
scope = {}
caps = dict(profiles=['omron-hem-7374t1', 'afu-wl-tz-a1'], max_scales=2, max_connections=3)


def status():
    pub(identity, 'status', dict(protocol_version=2, enrollment_nonce=nonce, online=True, bound=bool(scope), capabilities=caps, firmware='afu-ui-simulator', **scope))


status()
eventually(lambda: any(c['id'] == identity for c in api('collectors/discovered')), 'UI collector discovery')
api(f'collectors/{identity}/bind', dict(name='手机验收采集端', enrollment_nonce=nonce))
row = json.loads(sql(f"SELECT json_build_object('binding_id',c.binding_id,'instance_id',s.instance_id,'data_epoch',s.data_epoch) FROM collectors c CROSS JOIN system_state s WHERE c.id='{identity}'"))
scope.update(row)
status()
eventually(lambda: any(c['id'] == identity and c['lifecycle_state'] == 'bound' for c in api('collectors')), 'UI collector claim')
deadline = time.monotonic()+900
handled = set()
sent = set()
print('AFU UI simulator ready; stops after 15 minutes', flush=True)
while time.monotonic() < deadline:
    status()
    commands = json.loads(sql(f"SELECT coalesce(jsonb_agg(payload),'[]') FROM commands WHERE collector_id='{identity}' AND status='pending'"))
    targets = json.loads(sql(f"SELECT coalesce(jsonb_agg(t.payload),'[]') FROM operation_targets t JOIN operations o ON o.id=t.operation_id WHERE t.collector_id='{identity}' AND o.status IN('pending','preparing','committing')"))
    for command in commands+targets:
        key = (command['id'], command.get('phase'), command['type'])
        if key in handled:
            continue
        event = dict(protocol_version=2, command_id=command['id'], type=command['type'], **scope)
        if command['type'] == 'scan':
            data = dict(devices=[dict(name='AFU-WL-TZ-A1', address='02:00:00:00:00:99', address_type=0, hardware_id='03:00:00:00:00:99', profile='afu-wl-tz-a1', rssi=-45)])
            pub(identity, 'events', dict(event, status='succeeded', data=data))
        elif command.get('phase') == 'prepare':
            device = command['device_id']
            pub(identity, 'events', dict(event, type='baseline_chunk', status='running', data=dict(device_id=device, chunk_index=0, total_chunks=1, records=[])))
            pub(identity, 'events', dict(event, status='prepared', data=dict(devices=[device])))
        else:
            pub(identity, 'events', dict(event, status='succeeded', data={}))
        handled.add(key)
    for device in api('devices'):
        if device.get('collector_id') != identity or device['lifecycle_state'] != 'active' or device['id'] in sent:
            continue
        measurement = dict(version=2, message_id=uuid.uuid4().hex, collector_id=identity, device_id=device['id'], profile='afu-wl-tz-a1', user_slot=0, measurement_session_id=uuid.uuid4().hex, captured_at=datetime.now(timezone.utc).isoformat(timespec='seconds'), raw_hex='ac298069117002000540000a000000000029d51b', **scope)
        pub(identity, 'measurements', measurement)
        pub(identity, 'measurements', dict(measurement, message_id=uuid.uuid4().hex, impedance_raw_hex='ac29020001f401c20180691170000000000029d60f'))
        sent.add(device['id'])
    time.sleep(2)
print('AFU UI simulator stopped', flush=True)
