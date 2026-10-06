#!/bin/sh
# Cloudflare Pages build: copy ONLY the site into dist/ so that supabase/,
# tests/, docs/, ml-service/ and editor files are never published.
#   Build command:          sh build.sh
#   Build output directory: dist
set -eu
rm -rf dist
mkdir dist
cp -R index.html _headers admin student teacher assets styles dist/
find dist -name '.DS_Store' -delete
