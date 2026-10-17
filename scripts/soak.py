#!/usr/bin/env python3
"""Bounded Eir observation; no names, blood-pressure values, credentials or raw BLE data stored."""
import argparse
import datetime as dt
import json
import os
import pathlib
import signal
import time
import urllib.parse
import urllib.request


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def private_file(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, 'w', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--duration', type=int, default=86400, help='Observation seconds, at most 86400 (24 hours)')
    parser.add_argument('--interval', type=int, default=60, help='Poll interval in seconds')
    parser.add_argument('--max-pages', type=int, default=100, help='Bound measurement pagination per poll')
    parser.add_argument('--output', type=pathlib.Path, required=True, help='New private JSONL file; never overwrites')
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password:
        parser.error('--url must be an HTTP(S) server URL without credentials')
    if not 1 <= args.duration <= 86400 or not 1 <= args.interval <= 3600 or not 1 <= args.max_pages <= 100:
        parser.error('duration must be 1..86400, interval 1..3600, max-pages 1..100')
    summary_path = args.output.with_suffix('.summary.json')
    if summary_path.exists():
        parser.error('summary output already exists')
    summary = dict(started_at=utc(), requested_seconds=args.duration, poll_interval=args.interval,
                   polls=0, successful_polls=0, api_failed_polls=0, api_outage_episodes=0,
                   initial_measurement_count=None, initial_baseline_complete=False,
                   unique_records_observed=0, new_records_observed_after_baseline=None,
                   pagination_truncated_polls=0, collectors={},
                   completeness='Not proven: compare with independent measurement ground truth; API observations cannot detect measurements never collected.')
    stop = [False]
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.__setitem__(0, True))
    base = args.url.rstrip('/')
    seen = set()
    baseline = False
    was_failed = False
    started = time.monotonic()
    deadline = started + args.duration

    def fetch(path):
        request = urllib.request.Request(base + '/api/v1/' + path, headers={'Accept': 'application/json'})
        with urllib.request.urlopen(request, timeout=min(10, max(0.1, deadline - time.monotonic()))) as response:
            return json.load(response)

    with private_file(args.output) as out:
        def emit(value):
            out.write(json.dumps(value, ensure_ascii=False) + '\n')
            out.flush()
        emit({'type': 'start', 'at': utc(), 'requested_seconds': args.duration,
              'poll_interval': args.interval, 'initial_measurement_count': None})
        while not stop[0] and time.monotonic() < deadline:
            tick = time.monotonic()
            summary['polls'] += 1
            try:
                collectors = fetch('collectors')
                observed = []
                total = None
                complete = False
                for page in range(1, args.max_pages + 1):
                    if stop[0] or time.monotonic() >= deadline:
                        break
                    result = fetch(f'measurements?page_size=200&page={page}')
                    total = result['total']
                    records = result['items']
                    observed.extend({key: row.get(key) for key in
                                     ('id', 'device_id', 'device_time', 'measured_at', 'received_at')}
                                    for row in records)
                    if page * 200 >= total or not records:
                        complete = True
                        break
                if total is None:
                    break
                new = [row for row in observed if row['id'] not in seen]
                if not baseline:
                    summary['initial_measurement_count'] = total
                    summary['initial_baseline_complete'] = complete
                    summary['new_records_observed_after_baseline'] = 0 if complete else None
                elif summary['initial_baseline_complete']:
                    summary['new_records_observed_after_baseline'] += len(new)
                else:
                    summary['new_records_observed_after_baseline'] = None
                seen.update(row['id'] for row in observed)
                summary['unique_records_observed'] = len(seen)
                if not complete:
                    summary['pagination_truncated_polls'] += 1
                heartbeat = []
                for collector in collectors:
                    ident = collector['id']
                    status = collector.get('status') or {}
                    uptime = status.get('uptime', status.get('uptime_seconds'))
                    heap = status.get('free_heap', status.get('heap_free'))
                    queue = status.get('queue_depth', status.get('pending_count'))
                    stats = summary['collectors'].setdefault(ident, dict(observed_restarts=0,
                        min_free_heap=None, max_queue_depth=None, last_uptime=None,
                        offline_observations=0, error_observations=0))
                    if isinstance(uptime, (int, float)):
                        if stats['last_uptime'] is not None and uptime < stats['last_uptime']:
                            stats['observed_restarts'] += 1
                        stats['last_uptime'] = uptime
                    if isinstance(heap, (int, float)):
                        stats['min_free_heap'] = heap if stats['min_free_heap'] is None else min(heap, stats['min_free_heap'])
                    if isinstance(queue, (int, float)):
                        stats['max_queue_depth'] = queue if stats['max_queue_depth'] is None else max(queue, stats['max_queue_depth'])
                    error = str(status.get('last_error') or status.get('error') or '')[:256]
                    stats['error_observations'] += bool(error)
                    stats['offline_observations'] += collector.get('online') is False
                    heartbeat.append(dict(id=ident, online=collector.get('online'),
                        last_seen=collector.get('last_seen'), uptime=uptime, free_heap=heap,
                        queue_depth=queue, error=error))
                emit(dict(type='poll', at=utc(), elapsed_seconds=round(time.monotonic()-started, 2),
                          collectors=heartbeat, total_measurement_count=total,
                          baseline=not baseline, pagination_complete=complete, records=new))
                baseline = True
                summary['successful_polls'] += 1
                was_failed = False
            except Exception as error:
                summary['api_failed_polls'] += 1
                summary['api_outage_episodes'] += not was_failed
                was_failed = True
                emit({'type': 'api_error', 'at': utc(), 'error_type': type(error).__name__})
            next_tick = min(deadline, tick + args.interval)
            while not stop[0] and time.monotonic() < next_tick:
                time.sleep(min(1, next_tick - time.monotonic()))
        summary['ended_at'] = utc()
        summary['elapsed_seconds'] = round(time.monotonic() - started, 2)
        summary['duration_completed'] = not stop[0] and time.monotonic() >= deadline
        summary['interrupted'] = stop[0]
        summary['initial_count_known'] = baseline
        summary['restart_detection_limit'] = 'Uptime decreases only; restarts between polls can go undetected.'
        emit({'type': 'summary', **summary})
    with private_file(summary_path) as output:
        json.dump(summary, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(f'Observation saved: {args.output}; summary: {summary_path}')
    print(f"Elapsed {summary['elapsed_seconds']} seconds; duration completed={summary['duration_completed']}; completeness is not proven.")


if __name__ == '__main__':
    main()
