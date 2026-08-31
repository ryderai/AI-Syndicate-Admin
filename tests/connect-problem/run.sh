#!/usr/bin/env bash
# WHY THE MAILBOX DID NOT CONNECT — src/lib/connectProblem.js
set -u
cd "$(dirname "$0")/../.."
node tests/connect-problem/test.mjs
