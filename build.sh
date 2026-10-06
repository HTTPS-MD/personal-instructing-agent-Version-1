#!/bin/sh
# Cloudflare Pages build: copy ONLY the site into dist/ so that supabase/,
# tests/, docs/, ml-service/ and editor files are never published.
#   Build command:          sh build.sh
#   Build output directory: dist
set -eu
rm -rf dist
mkdir dist
cp -R index.html robots.txt _headers admin student teacher assets styles dist/
find dist -name '.DS_Store' -delete

# A top-level 404.html makes Cloudflare Pages answer unknown URLs with a real
# 404 instead of the landing page (status 200). The source page uses relative
# paths for the folder it lives in, so rewrite them to absolute ones.
sed -e 's#"\.\./\.\./styles/#"/styles/#g' \
    -e 's#"\.\./js/#"/assets/js/#g' \
    -e 's#"\.\./\.\./index\.html"#"/"#g' \
    assets/html/404.html > dist/404.html
