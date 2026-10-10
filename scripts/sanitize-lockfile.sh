#!/bin/sh
# Yarn pins tarball URLs into yarn.lock (__archiveUrl) when YARN_NPM_REGISTRY_SERVER points at a private
# registry; such a lockfile cannot install anywhere else, so strip them before they are committed.
set -eu
cd "$(dirname "$0")/.."
grep -q '__archiveUrl=' yarn.lock || exit 0
# patch: entries carry the locator percent-encoded, hence the second pattern
sed -i.bak -E 's/::__archiveUrl=[^"]*"/"/; s/%3A%3A__archiveUrl=[^#"]*//' yarn.lock
rm -f yarn.lock.bak
echo "yarn.lock: stripped registry-specific __archiveUrl entries"
