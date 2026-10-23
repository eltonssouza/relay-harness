#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export CI=true

# The run validates HEAD only when tracked files match it, before and after the gates.
clean_tree() { [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; }
sha=$(git rev-parse HEAD 2>/dev/null || true)
clean_at_start=0
if [ -n "$sha" ] && clean_tree; then clean_at_start=1; fi

# Keep the full pre-PR gate local. test.sh isolates credentials and user resources.
node --version
npm --version
npm ci --ignore-scripts
npm run build:offline
npm run check
node scripts/publish.mjs --dry-run
./test.sh
npm run check:package-install

printf '\nLocal CI passed for %s. Record the platform, Node version and validated commit in the PR.\n' "$sha"

# Report the required local/verify status for the validated commit. RELAY_CI_PUBLISH_STATUS=0 skips it.
# Publishing problems are reported but never fail a run whose gates passed.
[ "${RELAY_CI_PUBLISH_STATUS:-1}" = "0" ] && exit 0
if [ -z "$sha" ]; then
	printf 'local/verify not published: this is not a Git checkout.\n' >&2
	exit 0
fi
if [ "$clean_at_start" != 1 ] || ! clean_tree || [ "$(git rev-parse HEAD 2>/dev/null)" != "$sha" ]; then
	printf 'local/verify not published: tracked files differed from %s, so that commit was not what ran.\n' "$sha" >&2
	exit 0
fi
description="ci.sh passed on $(uname -s), Node $(node --version)"
if command -v gh >/dev/null 2>&1 &&
	gh api "repos/{owner}/{repo}/statuses/$sha" -f state=success -f context=local/verify \
		-f description="$description" >/dev/null; then
	printf 'Published local/verify success for %s.\n' "$sha"
else
	printf 'local/verify not published. Push %s, authenticate gh, then run:\n' "$sha" >&2
	printf '  gh api repos/{owner}/{repo}/statuses/%s -f state=success -f context=local/verify -f description="%s"\n' \
		"$sha" "$description" >&2
fi
