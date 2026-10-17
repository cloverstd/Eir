#!/usr/bin/env python3
"""Package a clean ESP-IDF build; no NVS, device credentials or health data."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--build',type=Path,default=Path('firmware/build'))
p.add_argument('--output',type=Path,default=Path('dist/firmware'))
p.add_argument('--commit',required=True)
p.add_argument('--tag',default='')
a=p.parse_args()
if not re.fullmatch(r'[0-9a-f]{40}',a.commit):p.error('commit must be a full Git SHA')
subprocess.run([sys.executable,'-m','esptool','--chip','esp32c3','image-info',str(a.build/'eir_collector.bin')],check=True)
manifest=json.loads(subprocess.check_output([sys.executable,'firmware/tools/manifest.py',str(a.build/'eir_collector.bin')]))
if a.tag and a.tag!='firmware-v'+manifest['version']:p.error('firmware tag and embedded project version differ')
a.output.mkdir(parents=True,exist_ok=False)
for name in ['eir_collector.bin','bootloader/bootloader.bin','partition_table/partition-table.bin','ota_data_initial.bin','flash_args','flasher_args.json']:
    src=a.build/name
    if src.exists():
        dst=a.output/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
args=json.loads((a.build/'flasher_args.json').read_text())
command=[sys.executable,'-m','esptool','--chip','esp32c3','merge-bin','-o',str((a.output/'factory.bin').resolve()),'--flash-size','4MB']
for offset,name in sorted(args['flash_files'].items(),key=lambda item:int(item[0],0)):
    command.extend([offset,str((a.build/name).resolve())])
subprocess.run(command,check=True)
manifest.update(commit=a.commit,idf_version='6.1',factory_file='factory.bin',source_url=f'https://github.com/cloverstd/Eir/tree/{a.commit}')
(a.output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for src in ['LICENSE','THIRD_PARTY_NOTICES.md']:
    shutil.copyfile(src,a.output/src)
(a.output/'README.txt').write_text('eir_collector.bin is the OTA application. factory.bin is for initial provisioning of an identified ESP32-C3 with 4 MB flash; it replaces partition/configuration regions. Existing devices should use the Eir OTA interface. Never flash unknown chips. See the corresponding source documentation.\n')
files=sorted(f for f in a.output.rglob('*') if f.is_file())
(a.output/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.relative_to(a.output)}\n' for f in files))
print(f'Packaged ESP32-C3 {manifest["version"]}: {manifest["size"]} bytes, commit {a.commit}')
