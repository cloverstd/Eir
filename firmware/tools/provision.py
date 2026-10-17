#!/usr/bin/env python3
"""Provision via USB without printing credentials or moving the host Wi-Fi.

Input file: {"ssid": "...", "password": "...", "mqtt_uri": "mqtt://...:1883"}
Requires pyserial. The JSON file must not be committed.
"""
import argparse
import json
import time
from pathlib import Path
import serial
from serial.tools import list_ports

p = argparse.ArgumentParser()
p.add_argument("--port", required=True)
p.add_argument("--config", type=Path, required=True)
a = p.parse_args()
ports = {x.device: x for x in list_ports.comports()}
port = ports.get(a.port)
if port is None or port.vid != 0x303A or port.pid != 0x1001:
    p.error("Port must identify as Espressif native USB (303a:1001)")
cfg = json.loads(a.config.read_text())
if not cfg.get("ssid") or not cfg.get("mqtt_uri"):
    p.error("Missing ssid or mqtt_uri")
with serial.Serial(a.port, 115200, timeout=0.2) as conn:
    conn.write(b"\nEIR_CONFIG " + json.dumps(cfg).encode() + b"\n")
    deadline = time.monotonic() + 15
    received = b""
    while time.monotonic() < deadline:
        received += conn.read(4096)
        if b"EIR_CONFIG_OK" in received:
            print("Configuration saved; device restarting.")
            break
    else:
        raise SystemExit("No provisioning acknowledgement. Check firmware/USB connection.")
