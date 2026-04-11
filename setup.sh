#!/usr/bin/env bash
set -euo pipefail

echo "=== VulnRap Local Setup ==="
echo ""

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (v20+). Install from https://nodejs.org"
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  echo "ERROR: pnpm is required (v9+). Install with: npm install -g pnpm"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (found v$(node -v))"
  exit 1
fi

if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
  echo "  -> Edit .env to set your DATABASE_URL before continuing."
  echo "     If you have Docker, run: docker compose up -d"
  echo "     Then use: DATABASE_URL=postgresql://vulnrap:vulnrap@localhost:5432/vulnrap"
  echo ""
  read -rp "Press Enter after configuring .env, or Ctrl+C to abort..."
fi

echo ""
echo "Installing dependencies..."
pnpm install

echo ""
echo "Pushing database schema..."
pnpm --filter @workspace/db run push

echo ""
echo "Generating API client code..."
pnpm --filter @workspace/api-spec run codegen

echo ""
read -rp "Seed example vulnerability reports? (y/N) " SEED
if [[ "$SEED" =~ ^[Yy]$ ]]; then
  echo "Building API server..."
  pnpm --filter @workspace/api-server run build
  echo "Seeding database..."
  pnpm --filter @workspace/api-server run seed
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Start the API server:   PORT=8080 pnpm --filter @workspace/api-server run dev"
echo "Start the frontend:     PORT=5173 pnpm --filter @workspace/vulnrap run dev"
echo ""
echo "Then open http://localhost:5173 in your browser."
echo ""
echo "NOTE: Community features (similarity matching against other users'"
echo "reports) require the hosted instance at https://vulnrap.com."
echo "Local instances operate with their own independent database."
echo ""
echo "LLM-enhanced scoring is optional. Set OPENAI_API_KEY in .env to enable it."
echo "Without it, VulnRap uses heuristic-only scoring (still fully functional)."
