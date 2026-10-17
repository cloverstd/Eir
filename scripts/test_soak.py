import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('soak', pathlib.Path(__file__).with_name('soak.py'))
soak = importlib.util.module_from_spec(spec)
spec.loader.exec_module(soak)


class ObservationTests(unittest.TestCase):
    def run_observation(self, path, fetch, duration):
        with patch('sys.argv', ['soak', '--output', str(path), '--duration', str(duration), '--interval', '1']), \
             patch.object(soak.urllib.request, 'urlopen', side_effect=fetch), patch('builtins.print'):
            soak.main()
        return json.loads(path.with_suffix('.summary.json').read_text())

    def test_private_metadata_restart_and_api_outage(self):
        poll = 0
        def fetch(request, **_):
            nonlocal poll
            if request.full_url.endswith('/collectors'):
                poll += 1
                if poll >= 3:
                    raise urllib.error.URLError('offline')
                data = [{'id': 'test', 'name': 'SECRET NAME', 'online': True,
                         'status': {'uptime': 100 if poll == 1 else 50, 'free_heap': 20000-poll,
                                    'queue_depth': poll, 'wifi_password': 'SECRET PASSWORD'}}]
            else:
                data = {'total': poll, 'items': [dict(id=str(i), device_id='device',
                    device_time='2026-10-17 10:00:00', received_at='2026-10-17T02:01:00Z',
                    systolic=111, raw_hex='SECRET RAW', member_name='SECRET NAME') for i in range(poll)]}
            return io.BytesIO(json.dumps(data).encode())
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)/'out.jsonl'
            summary = self.run_observation(path, fetch, 3)
            self.assertEqual(summary['collectors']['test']['observed_restarts'], 1)
            self.assertEqual(summary['new_records_observed_after_baseline'], 1)
            self.assertEqual(summary['api_outage_episodes'], 1)
            self.assertEqual(summary['initial_measurement_count'], 1)
            self.assertTrue(summary['duration_completed'])
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(path.with_suffix('.summary.json')).st_mode & 0o777, 0o600)
            text = path.read_text()
            self.assertNotIn('SECRET', text)
            self.assertNotIn('systolic', text)
            self.assertNotIn('raw_hex', text)

    def test_no_initial_api_access_does_not_invent_zero_baseline(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)/'out.jsonl'
            def unavailable(*args, **kwargs):
                raise urllib.error.URLError('offline')
            summary = self.run_observation(path, unavailable, 1)
            self.assertIsNone(summary['initial_measurement_count'])
            self.assertIsNone(summary['new_records_observed_after_baseline'])
            self.assertFalse(summary['initial_count_known'])
            self.assertEqual(summary['successful_polls'], 0)


if __name__ == '__main__':
    unittest.main()
