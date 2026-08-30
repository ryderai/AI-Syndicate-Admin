#!/usr/bin/env bash
# Moving a lead: the chip on the sheet, the drop target on the board, and the
# dropdown on the card all ask lib/stage-move.js. Pure logic, no browser.
set -e
cd "$(dirname "$0")/../.."
node tests/stage-move/test.mjs
