#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 2 ] || [ "$2" != "--replace-database" ]; then
  echo 'Usage: scripts/restore.sh BACKUP_DIRECTORY --replace-database' >&2
  echo 'Stops Eir and replaces the current Eir database. Use an isolated project to test restoration.' >&2
  exit 2
fi
backup_dir=$1
[ -s "$backup_dir/database.dump" ] && [ -s "$backup_dir/firmwares.tar.gz" ]
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore --list < "$backup_dir/database.dump" > /dev/null
tar tzf "$backup_dir/firmwares.tar.gz" > /dev/null
if [ -f "$backup_dir/documents.tar.gz" ]; then tar tzf "$backup_dir/documents.tar.gz" > /dev/null; fi
docker compose stop eir
# Do not automatically restart on failure: keep ingestion paused until recovery is completed.
docker compose exec -T postgres dropdb -U eir --if-exists eir
docker compose exec -T postgres createdb -U eir -O eir eir
docker compose exec -T postgres pg_restore -U eir -d eir --no-owner --exit-on-error < "$backup_dir/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar eir xzf - -C /data < "$backup_dir/firmwares.tar.gz"
if [ -f "$backup_dir/documents.tar.gz" ]; then
  docker compose run --rm --no-deps -T --entrypoint tar eir xzf - -C /data < "$backup_dir/documents.tar.gz"
fi
docker compose up -d --wait eir
echo 'Database and firmware restored; Eir is ready.'
