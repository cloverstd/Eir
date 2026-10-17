#!/usr/bin/env python3
"""Print an OTA upload manifest for an already-built ESP32-C3 image."""
import hashlib
import json
import sys
from pathlib import Path
p = Path(sys.argv[1])
b = p.read_bytes()
if len(b) < 288 or b[0] != 0xE9 or int.from_bytes(b[12:14], "little") != 5:
    raise SystemExit("Not an ESP32-C3 application")
if len(b) > 0x180000 or b"EIR_PARTITION_LAYOUT=eir-c3-v1" not in b:
    raise SystemExit("Image incompatible with Eir partition layout")
print(json.dumps({"file": p.name, "version": b[48:80].split(b"\0")[0].decode(),
                  "chip": "esp32c3", "partition_layout": "eir-c3-v1", "size": len(b),
                  "sha256": hashlib.sha256(b).hexdigest()}, indent=2))
