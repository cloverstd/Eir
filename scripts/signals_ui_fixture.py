#!/usr/bin/env python3
"""Ten-minute synthetic signal source for isolated browser acceptance only."""
import hashlib
import json
import math
import time
import uuid
from datetime import datetime, timezone
from lifecycle_support import api, pub, sql, verify_isolation

verify_isolation()
collector='ui-signals-collector'
boot=uuid.uuid4().hex
sql(f"INSERT INTO collectors(id,name,protocol_version,lifecycle_state) VALUES('{collector}','客厅 ESP32 · 模拟',2,'bound') ON CONFLICT(id) DO NOTHING")
scope=json.loads(sql(f"SELECT json_build_object('instance_id',s.instance_id,'data_epoch',s.data_epoch,'binding_id',c.binding_id) FROM system_state s CROSS JOIN collectors c WHERE c.id='{collector}'"))
member=api('members',dict(name='路由验收成员 · 模拟',sex='male',birth_date='1990-01-01',height_cm=170))
device=str(uuid.uuid4());scale=str(uuid.uuid4())
sql(f"INSERT INTO devices(id,name,collector_id,address,lifecycle_state) VALUES('{device}','客厅血压计 · 模拟','{collector}','02:00:00:00:00:61','active')")
sql(f"INSERT INTO devices(id,name,collector_id,address,profile,model,hardware_id,lifecycle_state) VALUES('{scale}','浴室体脂秤 · 模拟','{collector}','02:00:00:00:00:62','afu-wl-tz-a1','AFU-WL-TZ-A1','03:00:00:00:00:62','active')")
for i in range(55):
    identifier=str(uuid.uuid4());fingerprint=hashlib.sha256(identifier.encode()).hexdigest()
    sql(f"INSERT INTO measurements(id,fingerprint,device_id,collector_id,user_slot,record_sequence,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags) VALUES('{identifier}','{fingerprint}','{device}','{collector}',1,{i},'synthetic',now()-interval '{i} hours','Asia/Shanghai','{member['id']}',decode('00','hex'),'synthetic-fixture',0);INSERT INTO blood_pressure(measurement_id,systolic,diastolic,pulse) VALUES('{identifier}',120,80,70)")
print(json.dumps(dict(member=member['id'],device=device,scale=scale,collector=collector)),flush=True)
deadline=time.monotonic()+600
seq=0
while time.monotonic()<deadline:
    seq+=1
    if seq%2==1:
        pub(collector,'status',dict(protocol_version=2,online=True,bound=True,firmware='0.3.9-simulator',boot_id=boot,capabilities={'signals':True,'profiles':['omron-hem-7374t1','afu-wl-tz-a1'],'max_scales':2},**scope))
    pub(collector,'signals',dict(protocol_version=2,boot_id=boot,sequence=seq,sent_at=datetime.now(timezone.utc).isoformat(),samples=[
        dict(kind='wifi',source='wifi',rssi=-55-int(3*math.sin(seq)),age_ms=0,connected=True),
        dict(kind='ble',device_id=device,source='advertisement',rssi=-72-int(4*math.sin(seq)),age_ms=0,connected=False),
        dict(kind='ble',device_id=scale,source='connection',rssi=-82-int(3*math.sin(seq)),age_ms=0,connected=True)],**scope))
    time.sleep(5)
