#!/usr/bin/env python3
"""Bounded, read-only BLE overlap observation; never stores health values."""
import argparse
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--url', required=True)
p.add_argument('--output', required=True, type=Path)
p.add_argument('--duration', type=int, default=180)
p.add_argument('--interval', type=float, default=.25)
a = p.parse_args()
if not 1 <= a.duration <= 600 or not .2 <= a.interval <= 10:
    p.error('duration must be 1..600 seconds and interval 0.2..10 seconds')
a.output.parent.mkdir(parents=True, exist_ok=True)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
start = time.monotonic()
overlap = 0
samples = 0
failures = 0
minimum_heap = None
with os.fdopen(os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
    while time.monotonic()-start < a.duration:
        row = {'time': datetime.now(timezone.utc).isoformat()}
        try:
            with opener.open(a.url.rstrip('/')+'/status', timeout=3) as response:
                data = json.load(response)
            connections = [{'id': d.get('id'), 'profile': d.get('profile'), 'connected': d.get('connected', False)} for d in data.get('devices', [])]
            row.update(firmware=data.get('firmware'), uptime=data.get('uptime'), free_heap=data.get('free_heap'), min_free_heap=data.get('min_free_heap'), queue_depth=data.get('queue_depth'), ble_scanning=data.get('ble_scanning'), devices=connections, error=data.get('error'))
            active = {d['profile'] for d in connections if d['connected']}
            row['overlap'] = {'omron-hem-7374t1', 'afu-wl-tz-a1'} <= active
            overlap += int(row['overlap'])
            samples += 1
            if isinstance(row['free_heap'], int):
                minimum_heap = row['free_heap'] if minimum_heap is None else min(minimum_heap, row['free_heap'])
        except (OSError, ValueError) as e:
            row['probe_error'] = type(e).__name__
            failures += 1
        output.write(json.dumps(row, ensure_ascii=False)+'\n')
        output.flush()
        time.sleep(a.interval)
summary = dict(duration_seconds=round(time.monotonic()-start, 2), samples=samples, probe_failures=failures, overlap_samples=overlap, minimum_free_heap=minimum_heap)
summary_path = Path(str(a.output)+'.summary.json')
with os.fdopen(os.open(summary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
    json.dump(summary, output, indent=2)
print(json.dumps(summary), flush=True)
