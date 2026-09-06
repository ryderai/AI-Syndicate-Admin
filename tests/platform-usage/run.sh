#!/usr/bin/env bash
# PLATFORM USAGE — the database half, and the seam between the two repos.
#
# TWO PARTS, AND BOTH ANNOUNCE WHEN THEY SKIP.
#
#   sql.sh    every migration on a real Postgres, then 0032's behaviour
#             attacked. Needs a local Postgres.
#   e2e.mjs   a real metered call in the PLATFORM repo, through the REAL
#             ingest endpoint here, into a real Postgres, read back through
#             the real views. Needs a Postgres AND a checkout of the platform
#             repo, so it is normally run by hand in the cloud container:
#
#               E2E_PG=postgresql://...            \
#               PLATFORM_LIB=/path/to/platform/lib \
#               ADMIN_LIB=$PWD/lib ADMIN_API=$PWD/api \
#               node --experimental-test-module-mocks --test tests/platform-usage/e2e.mjs
#
# A SKIP IS NOT A PASS. Three real defects were found by the e2e half and by
# nothing else, because each one lived in the gap between two files that each
# had a green suite:
#   * cost_usd was `not null default 0` while the ingest endpoint wrote NULL
#     for an unpriced call — the first batch containing one would have been
#     refused whole, as a 500.
#   * input_tokens likewise, so a paid call with no tokens could not be stored.
#   * JSON.stringify drops an undefined value, so "unknown" was arriving as an
#     absent key rather than an explicit null.
set -u
cd "$(dirname "$0")/../.."
rc=0

bash tests/platform-usage/sql.sh || rc=1

echo ""
if [ -n "${E2E_PG:-}" ] && [ -n "${PLATFORM_LIB:-}" ]; then
  echo "== end to end: platform -> ingest -> database =="
  ADMIN_LIB="$PWD/lib" ADMIN_API="$PWD/api" \
    node --experimental-test-module-mocks --test tests/platform-usage/e2e.mjs
  e2e_rc=$?
  # 77 is this repo's "skipped" code. It is NOT success.
  [ $e2e_rc -eq 0 ] || rc=1
else
  echo "  --   E2E_PG or PLATFORM_LIB not set; the end-to-end half was SKIPPED."
  echo "       A skip is not a pass. See the header of this file for the command."
  rc=1
fi

# ALLOW_SQL_SKIP=1 used to make this whole file exit 0 with BOTH halves skipped
# — one env var turning a suite that ran nothing into a green tick, which is
# the failure the 77 convention exists to stop. It now only forgives the SQL
# half, and the line below says out loud what actually ran.
if [ $rc -ne 0 ]; then
  echo ""
  echo "  platform-usage: NOT fully verified on this machine (a skip is not a pass)."
fi
exit $rc
