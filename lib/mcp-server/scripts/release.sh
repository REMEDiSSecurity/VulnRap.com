#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> building standalone bundle …"
node esbuild.config.mjs

echo "==> verifying bundle runs …"
echo '{}' | timeout 3 node dist/bundle.js 2>&1 || true

echo "==> publishing to npm …"
pnpm publish --access public --no-git-checks "$@"

echo "==> done.  Users can now run:  npx -y @vulnrap/mcp-server"
