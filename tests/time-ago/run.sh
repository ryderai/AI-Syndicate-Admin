#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."
node tests/time-ago/test.mjs
