#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
exec bun ./scripts/build/package.mjs "$@"
