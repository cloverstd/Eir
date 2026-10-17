#!/usr/bin/env python3
"""Upload an ESP32-C3 application and execute an Eir OTA job over the LAN."""
import argparse,json,pathlib,time,urllib.request,uuid
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--url',default='http://127.0.0.1:8080')
p.add_argument('--collector',required=True)
p.add_argument('--file',type=pathlib.Path,required=True)
p.add_argument('--timeout',type=int,default=180)
a=p.parse_args();op=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=a.url.rstrip('/')+'/api/v1/'
def api(path,data=None,content='application/json'):
 req=urllib.request.Request(base+path,data=data,headers={'Content-Type':content})
 return json.load(op.open(req,timeout=20))
boundary='eir'+uuid.uuid4().hex
binary=a.file.read_bytes()
if len(binary)>0x180000:raise SystemExit('Image exceeds C3 OTA slot')
body=('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="eir.bin"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()+binary+('\r\n--'+boundary+'--\r\n').encode()
f=api('firmwares',body,'multipart/form-data; boundary='+boundary)
j=api('ota-jobs',json.dumps({'collector_id':a.collector,'firmware_id':f['id']}).encode())
print(json.dumps({'firmware':f,'job':j}),flush=True)
end=time.monotonic()+a.timeout;previous=''
while time.monotonic()<end:
 jobs=api('ota-jobs');job=next(x for x in jobs if x['id']==j['id'])
 if job['status']!=previous:print(json.dumps(job),flush=True);previous=job['status']
 if job['status'] in ('succeeded','failed','rolled_back'):raise SystemExit(0 if job['status']=='succeeded' else 1)
 time.sleep(5)
raise SystemExit('Timed out; inspect OTA job in Eir before retrying')
