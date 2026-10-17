#!/usr/bin/env python3
"""Create an isolated, intentionally failing OTA test project. Never a release.

Only use after a confirmed-good baseline and with no active collection. The test
restarts on an OTA software reset before validating itself, so bootloader must
return to the previously valid app. This script never modifies release sources.
"""
import argparse
import shutil
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('destination',type=Path)
a=p.parse_args()
source=Path(__file__).resolve().parents[1]
a.destination.mkdir(parents=True,exist_ok=False)
for name in ['CMakeLists.txt','sdkconfig.defaults','partitions.csv','dependencies.lock']:
    shutil.copy2(source/name,a.destination/name)
shutil.copytree(source/'main',a.destination/'main')
f=a.destination/'main'/'main.cpp'
s=f.read_text()
needle='extern "C" void app_main() {'
assert needle in s
s=s.replace(needle,needle+'\n  // INTENTIONAL TEST FAILURE: never confirm this OTA image.\n  if(esp_reset_reason()==ESP_RST_SW){vTaskDelay(pdMS_TO_TICKS(1000));esp_restart();}\n',1)
f.write_text(s)
f=a.destination/'CMakeLists.txt'
f.write_text(f.read_text().replace('VERSION 0.1.3','VERSION 0.1.99'))
print('Isolated rollback test project:',a.destination)
