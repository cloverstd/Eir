"""Synthetic-only health/archive/migration acceptance in an isolated Compose project."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
import zlib
import struct
from lifecycle_support import api, sql, compose, verify_isolation, BASE
verify_isolation()

def upload(member,content,filename,metadata=None,expected=201):
    boundary=uuid.uuid4().hex
    parts=[]
    for key,value in {"title":"Synthetic report", "category":"report", **(metadata or {})}.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+content+b'\r\n')
    body=b''.join(parts)+f'--{boundary}--\r\n'.encode()
    request=urllib.request.Request(f'{BASE}/api/v1/members/{member}/documents',data=body,headers={'Content-Type':f'multipart/form-data; boundary={boundary}'})
    try: response=urllib.request.urlopen(request,timeout=60)
    except urllib.error.HTTPError as error: response=error
    with response:
        raw=response.read()
        assert response.status==expected,(response.status,raw[:300])
        return json.loads(raw)

def pdf(text=True):
    # Entirely generated test content, never a patient report.
    stream=b'BT /F1 16 Tf 30 120 Td (Synthetic report only) Tj ET' if text else b'0 0.5 0.3 rg 20 20 150 100 re f'
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
    out=bytearray(b'%PDF-1.4\n');offsets=[0]
    for n,value in enumerate(objects,1): offsets.append(len(out));out.extend(f'{n} 0 obj\n'.encode()+value+b'\nendobj\n')
    xref=len(out);out.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]: out.extend(f'{offset:010d} 00000 n \n'.encode())
    out.extend(f'trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode());return bytes(out)

def png():
    def chunk(kind,data): return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',64,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\x40\x80\xc0'*64)*64))+chunk(b'IEND',b'')

if '--finish' in sys.argv:
    preview=api('operations/preview',{'type':'system_reset','scope':'all'})
    assert preview['counts']['documents']>=1 and preview['counts']['health_history']>=1
    api('system/reset',{'scope':'all','preview_token':preview['preview_token'],'confirmation':'RESET'})
    assert sql('SELECT count(*) FROM medical_documents')=='0'
    assert sql('SELECT count(*) FROM health_history')=='0'
    assert sql('SELECT count(*) FROM manual_observations')=='0'
    assert api('members')==[]
    print('PASS full reset includes archives and documents; cleanup completed')
    raise SystemExit

m=api('members',{'name':'Synthetic member','sex':'male','height_cm':170,'birth_month':'1990-10','blood_type':'A+'})
id=m['id'];assert m['birth_date'] is None and m['birth_month']=='1990-10'
other=api('members',{'name':'Synthetic other'})['id']
api('members/'+id,{'name':m['name'],'birth_date':'1990-10-18'},method='PUT')
assert api('members/'+id)['birth_date'].startswith('1990-10-18')
api('members/'+id,{'name':m['name'],'birth_month':'1991-03'},method='PUT')
assert api('members/'+id)['birth_date'] is None
api('members/'+id,{'name':m['name'],'birth_month':'2999-01'},method='PUT',expected=400)
api('members/'+id,{'name':m['name'],'blood_type':'bad'},method='PUT',expected=400)
api('members/'+id,{'name':m['name'],'height_cm':None},method='PUT')
assert api('members/'+id)['height_cm'] is None
api('members/'+id,{'name':m['name'],'height_cm':170},method='PUT')
print('PASS precise and partial birth dates; optional profile fields; invalid values')

histories=[]
for kind in ('condition','surgery','allergy','medication','family'):
    h=api(f'members/{id}/history',{'kind':kind,'title':'Synthetic '+kind,'status':'active','occurred_on':'2020-01-01','details':{'reaction':'Synthetic detail'} if kind=='allergy' else {},'notes':'Synthetic notes'})
    histories.append(h)
assert api(f'health/history?member_id={id}&page_size=2&page=2')['total']==5
assert len(api(f'health/history?member_id={id}&kind=allergy')['items'])==1
api(f'members/{other}/history/{histories[0]["id"]}',{'kind':'condition','title':'Must not overwrite'},method='PUT',expected=404)
print('PASS all history kinds; pagination; member ownership')

for kind,value in [('height',170),('weight',70),('body_fat',20),('waist',80),('blood_pressure',120),('heart_rate',70),('blood_glucose',5.5),('oxygen_saturation',98),('temperature',36.5)]:
    api(f'members/{id}/observations',{'kind':kind,'value':value,'value_secondary':80 if kind=='blood_pressure' else None,'measured_at':'2026-01-02T03:00:00Z'})
result=api(f'health/observations?member_id={id}&page_size=2&page=1');assert result['total']==10 and len(result['items'])==2
bmi=api(f'health/observations?member_id={id}&kind=bmi')['items'][0];assert abs(float(bmi['value'])-24.22)<.01 and bmi['estimated']
assert len(api(f'health/statistics?member_id={id}&kind=blood_pressure&group=day')['items'])==1
api(f'members/{id}/observations',{'kind':'blood_pressure','value':120,'measured_at':'2026-01-02T03:00:00Z'},expected=400)
api(f'members/{id}/observations',{'kind':'custom','value':1,'measured_at':'2026-01-02T03:00:00Z'},expected=400)
api(f'members/{id}/observations',{'kind':'blood_glucose','value':100,'unit':'mg/dL','measured_at':'2026-01-02T03:00:00Z'},expected=400)
api('health/observations?page=bad',expected=400)
api('health/observations?from=bad',expected=400)
print('PASS fixed metric units, BMI, dates, statistics and pagination')

docs=[]
for filename,content in [('report.pdf',pdf()),('scan.pdf',pdf(False)),('photo.png',png()),('photo.webp',base64.b64decode('UklGRh4AAABXRUJQVlA4TBEAAAAvD8ADAAdQwAIVuP+BiOh/AAA='))]:
    d=upload(id,content,filename,{'history_id':histories[0]['id']});docs.append((d,content))
    downloaded=urllib.request.urlopen(BASE+'/api/v1/documents/'+d['id']+'/download').read()
    assert hashlib.sha256(downloaded).hexdigest()==d['sha256']==hashlib.sha256(content).hexdigest()
    preview=urllib.request.urlopen(BASE+'/api/v1/documents/'+d['id']+'/pages/1').read();assert len(preview)>20
assert 'Synthetic report' in api('documents/'+docs[0][0]['id']+'/text')['text']
assert api('documents/'+docs[1][0]['id']+'/text')['text'].strip()==''
upload(other,png(),'photo.png',{'history_id':histories[0]['id']},expected=400)
upload(id,b'<html>not an image</html>','report.pdf',expected=400)
upload(id,b'bad','photo.png',expected=400)
upload(id,b'x'*(25*1024*1024+1),'large.pdf',expected=400)
# The runtime's conversion tools produce synthetic JPEG and HEIC fixtures from our generated PNG.
compose('exec','-T','--user','root','eir','sh','-c','mkdir -p /tmp/eir-fixtures; cat > /tmp/eir-fixtures/source.png',input=png(),capture_output=True)
compose('exec','-T','--user','root','eir','heif-enc','-q','40','-o','/tmp/eir-fixtures/photo.heic','/tmp/eir-fixtures/source.png',capture_output=True)
compose('exec','-T','--user','root','eir','heif-convert','/tmp/eir-fixtures/photo.heic','/tmp/eir-fixtures/photo.jpg',capture_output=True)
for name in ('photo.heic','photo.jpg'):
    content=compose('exec','-T','eir','cat','/tmp/eir-fixtures/'+name,capture_output=True).stdout
    d=upload(id,content,name);docs.append((d,content));assert urllib.request.urlopen(BASE+'/api/v1/documents/'+d['id']+'/pages/1').status==200
assert api(f'health/documents?member_id={id}&page_size=2&page=2')['total']==6
assert compose('exec','-T','eir','sh','-c','find /data/documents -maxdepth 1 -name ".upload-*" | wc -l',capture_output=True,text=True).stdout.strip()=='0'
print('PASS PDF text, scanned/vector PDF, PNG, WebP, JPEG, HEIC, SHA-256 and failed upload cleanup')

# Measurements-only reset preserves clinical history and document metadata/files.
preview=api('operations/preview',{'type':'system_reset','scope':'measurements'})
assert preview['counts']['manual_observations']==9 and preview['counts']['documents']==0
api('system/reset',{'scope':'measurements','preview_token':preview['preview_token'],'confirmation':'RESET'})
assert sql('SELECT count(*) FROM manual_observations')=='0'
assert api(f'health/history?member_id={id}')['total']==5 and api(f'health/documents?member_id={id}')['total']==6
api(f'members/{id}/observations',{'kind':'weight','value':70,'measured_at':'2026-01-02T03:00:00Z'})
# Synthetic device records join the same observation API as manual ones.
device=sql("INSERT INTO devices(name,address,profile) VALUES('Synthetic meter','AA:BB:CC:DD:EE:90','omron-hem-7374t1') RETURNING id").splitlines()[0]
measurement=sql(f"INSERT INTO measurements(fingerprint,device_id,member_id,user_slot,kind,record_sequence,device_time,measured_at,timezone,raw_data,parser_version,raw_flags) VALUES('health-test-synthetic','{device}','{id}',1,'blood_pressure',1,'2026-01-02 11:00:00','2026-01-02T03:00:00Z','Asia/Shanghai',decode('00','hex'),'synthetic',0) RETURNING id").splitlines()[0]
sql(f"INSERT INTO blood_pressure VALUES('{measurement}',120,80,70)")
assert api(f'health/observations?member_id={id}&kind=blood_pressure')['items'][0]['source']=='device'
print('PASS manual/device unified observations; measurements-only reset preserves clinical archives')
backup_scale=sql("INSERT INTO devices(name,address,profile,model) VALUES('Synthetic numbered scale','02:00:00:00:00:91','afu-wl-tz-a1','AFU-WL-TZ-A1') RETURNING id").splitlines()[0]
backup_scale_number=int(sql(f"SELECT scale_number FROM devices WHERE id='{backup_scale}'"))
assert backup_scale_number>0

with tempfile.TemporaryDirectory(prefix='eir-test-health-backup-') as tmp:
    destination=str(Path(tmp)/'snapshot');subprocess.run(['./scripts/backup.sh',destination],check=True)
    subprocess.run(['./scripts/restore.sh',destination,'--replace-database'],check=True)
    for d,content in docs:
        restored=urllib.request.urlopen(BASE+'/api/v1/documents/'+d['id']+'/download').read();assert restored==content
    assert api(f'health/history?member_id={id}')['total']==5
    assert api(f'health/observations?member_id={id}&kind=weight')['total']==1
    assert int(sql(f"SELECT scale_number FROM devices WHERE id='{backup_scale}'"))==backup_scale_number
    next_number=int(sql("INSERT INTO devices(name,address,profile,model) VALUES('Synthetic restored sequence','02:00:00:00:00:92','afu-wl-tz-a1','AFU-WL-TZ-A1') RETURNING scale_number").splitlines()[0])
    assert next_number>backup_scale_number,'Restored scale sequence reused an existing number'
print('PASS database + firmware + medical-file backup and actual restoration')

# Build a genuine pre-health schema in another database inside this isolated project.
compose('exec','-T','postgres','createdb','-U','eir','eir_upgrade',capture_output=True)
legacy='\n'.join(Path('internal/store/'+name).read_text() for name in ('schema.sql','lifecycle.sql','body.sql'))
compose('exec','-T','postgres','psql','-U','eir','-d','eir_upgrade','-v','ON_ERROR_STOP=1',input=legacy.encode(),capture_output=True)
legacy_id=str(uuid.uuid4())
seed=f"INSERT INTO members(id,name,sex,height_cm,birth_date) VALUES('{legacy_id}','Synthetic legacy','female',165,'1980-06-15');"
compose('exec','-T','postgres','psql','-U','eir','-d','eir_upgrade','-v','ON_ERROR_STOP=1',input=seed.encode(),capture_output=True)
legacy_device=str(uuid.uuid4());legacy_body=str(uuid.uuid4());legacy_bp=str(uuid.uuid4())
seed=f"""INSERT INTO collectors(id) VALUES('legacy-synthetic');
INSERT INTO devices(id,name,address,collector_id) VALUES('{legacy_device}','Synthetic legacy meter','AA:BB:CC:DD:EE:77','legacy-synthetic');
INSERT INTO bindings(device_id,user_slot,member_id,effective_from) VALUES('{legacy_device}',1,'{legacy_id}','2020-01-01');
INSERT INTO measurements(id,fingerprint,device_id,collector_id,member_id,user_slot,kind,record_sequence,device_time,measured_at,timezone,raw_data,parser_version,raw_flags) VALUES('{legacy_bp}','synthetic-legacy-bp','{legacy_device}','legacy-synthetic','{legacy_id}',1,'blood_pressure',1,'2025-01-02 11:00:00','2025-01-02T03:00:00Z','Asia/Shanghai',decode('00','hex'),'synthetic',0),('{legacy_body}','synthetic-legacy-body','{legacy_device}','legacy-synthetic','{legacy_id}',0,'body_composition',NULL,'','2025-01-02T03:00:00Z','Asia/Shanghai',decode('00','hex'),'synthetic',0);
INSERT INTO blood_pressure VALUES('{legacy_bp}',120,80,70);
INSERT INTO body_composition(measurement_id,measurement_session_id,weight_grams,adc_index,bmi,body_fat_pct,body_fat_status,profile_snapshot) VALUES('{legacy_body}','synthetic-session',70000,0,25.71,23,'estimated','{{"sex":"female","height_cm":165,"birth_date":"1980-06-15","age":44}}');"""
compose('exec','-T','postgres','psql','-U','eir','-d','eir_upgrade','-v','ON_ERROR_STOP=1',input=seed.encode(),capture_output=True)
legacy_query="SELECT row_to_json(t) FROM (SELECT (SELECT jsonb_agg(row_to_json(m)) FROM members m) AS members,(SELECT jsonb_agg(row_to_json(d)) FROM devices d) AS devices,(SELECT jsonb_agg(row_to_json(b)) FROM bindings b) AS bindings,(SELECT jsonb_agg(row_to_json(m)) FROM measurements m) AS measurements,(SELECT jsonb_agg(row_to_json(c)) FROM body_composition c) AS body) t"
def legacy_state():
    data=compose('exec','-T','postgres','psql','-U','eir','-d','eir_upgrade','-At','-c',legacy_query,capture_output=True,text=True).stdout
    obj=json.loads(data)
    for member in obj['members']:
        member.pop('birth_month',None);member.pop('blood_type',None)
    for device in obj['devices']:
        # New metadata is allowed; every original registration field is compared.
        device.pop('scale_number',None)
    return obj
before_migration=legacy_state()

url='postgres://eir:'+os.environ['POSTGRES_PASSWORD']+'@postgres:5432/eir_upgrade?sslmode=disable'
for _ in range(2): compose('run','--rm','--no-deps','-T','-e','DATABASE_URL='+url,'eir','migrate',capture_output=True)
assert legacy_state()==before_migration, 'Legacy records or calculation snapshots changed'
assert compose('exec','-T','postgres','psql','-U','eir','-d','eir_upgrade','-At','-c',"SELECT bool_and(scale_number IS NULL) FROM devices WHERE profile='omron-hem-7374t1'",capture_output=True,text=True).stdout.strip()=='t'
check=compose('exec','-T','postgres','psql','-U','eir','-d','eir_upgrade','-At','-c',f"SELECT name,sex,height_cm,birth_date,birth_month FROM members WHERE id='{legacy_id}'",capture_output=True,text=True).stdout.strip()
assert check=='Synthetic legacy|female|165|1980-06-15|1980-06',check
print('PASS pre-health database migration and repeated startup preserve old member fields')
