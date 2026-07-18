#!/usr/bin/env bash
#
# One-shot setup + run for local development.
#
#   ./scripts/dev.sh          # setup (if needed) then start the dev server
#   npm run dev:setup         # same thing, via package.json
#
# Idempotent: installs deps only when missing, seeds .env.local from the
# example only when absent, then starts Next.js on http://localhost:3000.
set -euo pipefail

# Repo root, regardless of where this is invoked from.
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

# 1. Install dependencies if they aren't there yet.
if [ ! -d node_modules ]; then
  echo "→ Installing dependencies (npm install)…"
  npm install
else
  echo "✓ Dependencies already installed."
fi

# 2. Seed .env.local from the example on first run.
if [ ! -f .env.local ]; then
  echo "→ Creating .env.local from .env.example…"
  cp .env.example .env.local
  echo "  ⚠  Fill in ANTHROPIC_API_KEY and GOOGLE_MAPS_API_KEY in .env.local"
  echo "     for trip building + maps. Browsing existing trips works without them."
else
  echo "✓ .env.local already present."
fi

# 3. Start the dev server.
echo ""
echo "→ Starting dev server on http://localhost:${PORT}"
echo ""
exec npm run dev -- -p "${PORT}"
