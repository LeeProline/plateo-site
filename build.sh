#!/bin/sh
# Builds ./dist (what Cloudflare serves) from the site files. The sign-up Worker lives in ./worker and is deployed separately.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
rsync -a --exclude .git --exclude worker --exclude dist --exclude node_modules --exclude '*.md' --exclude build.sh --exclude wrangler.jsonc --exclude .gitignore ./ dist/
