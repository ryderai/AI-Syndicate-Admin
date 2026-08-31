#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."
node tests/people/test.mjs
