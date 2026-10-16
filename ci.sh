#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export CI=true

# Keep the full pre-PR gate local. test.sh isolates credentials and user resources.
node --version
npm --version
npm ci --ignore-scripts
npm run build
npm run check
node scripts/publish.mjs --dry-run
./test.sh
npm run check:package-install

printf '\nLocal CI passed. Record the platform, Node version and validated commit in the PR.\n'
