#!/usr/bin/env bash
# WHERE DOES AN ADDRESS PUT A PERSON — src/lib/pageForAddress.js
#
# The rule that decides which page an address means for the role looking at it:
# the renames, the per-role splits, the fallback, and the query the Gmail
# sign-in bounces back through. Pure node, no browser, no database.
set -u
cd "$(dirname "$0")/../.."
node tests/page-for-address/test.mjs
