#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export CI=true

# Keep the full pre-PR gate local. test.sh isolates credentials and user resources.
node --version
npm --version
npm ci --ignore-scripts
npm run build:offline
npm run check
# The Rust harness core: formatting, lints and tests, including its classification of every
# reference command against the TypeScript harness (tests/fixtures/classification.json).
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
# The desktop shell embeds the screen built above (packages/desktop/dist).
cargo clippy -p relay-desktop --all-targets --locked -- -D warnings
cargo test --locked
node scripts/publish.mjs --dry-run
./test.sh
npm run check:package-install

printf '\nLocal CI passed. Record the platform, Node version and validated commit in the PR.\n'
