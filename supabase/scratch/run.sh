#!/bin/bash
# usage: run.sh <dbname> <migration files...>   (scratch PostgreSQL only; never a live database)
# Needs a scratch cluster listening on /tmp:54329, e.g.
#   initdb -D /tmp/pia-scratch-pg -U postgres --auth=trust
#   LC_ALL=en_US.UTF-8 pg_ctl -D /tmp/pia-scratch-pg -o "-p 54329 -k /tmp" start
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH LC_ALL=en_US.UTF-8
DB=$1; shift
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
psql -h /tmp -p 54329 -U postgres -q -c "drop database if exists $DB" -c "create database $DB" || exit 1
$P -d $DB -f "$HERE/stub_live_only_objects.sql" || { echo "STUB FAILED"; exit 1; }
for f in "$@"; do echo "== $f"; $P -d $DB -f "$f" 2>&1 | tail -8; done
