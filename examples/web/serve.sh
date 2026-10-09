#!/bin/sh
# Serve the repository root on http://127.0.0.1:8000 and bundle main.ts on every request:
# the page fetches examples/ (cubes, data, queries) and packages/semtrans/rules/ from it.
cd "$(dirname "$0")/../.." || exit 1
# esbuild stops serving when stdin closes; the pipe keeps it open under a supervisor.
sleep infinity | npx esbuild examples/web/main.ts --bundle --format=esm --outdir=examples/web/dist \
  --external:'node:*' --servedir=. --serve=127.0.0.1:8000
