#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
backup_dir=${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}
if [ -e "$backup_dir" ]; then
  echo "Refusing to overwrite existing backup directory: $backup_dir" >&2
  exit 1
fi
mkdir -p "$backup_dir"
paused=0
cleanup() {
  if [ "$paused" = 1 ]; then docker compose unpause eir >/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
# Only this Compose project's Eir is paused; PostgreSQL/MQTT continue running.
docker compose pause eir
paused=1
docker compose exec -T postgres pg_dump -U eir -d eir -Fc > "$backup_dir/database.dump.tmp"
mv "$backup_dir/database.dump.tmp" "$backup_dir/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar eir czf - -C /data firmwares > "$backup_dir/firmwares.tar.gz.tmp"
mv "$backup_dir/firmwares.tar.gz.tmp" "$backup_dir/firmwares.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar eir czf - -C /data documents > "$backup_dir/documents.tar.gz.tmp"
mv "$backup_dir/documents.tar.gz.tmp" "$backup_dir/documents.tar.gz"
printf '%s\n' '2' > "$backup_dir/format-version"
# Application writes and file cleanup stay paused until the snapshot is complete.
printf '%s\n' 'Eir PostgreSQL custom dump + firmware and medical document files. Configuration/secrets are not included.' > "$backup_dir/README.txt"
echo "Backup saved: $backup_dir"
