#!/usr/bin/env bash
#
# Setup + run the trip-planner locally.
#
#   ./run.sh          # install deps (if needed), then start the dev server
#   ./run.sh setup    # install deps + create .env.local, then exit
#   PORT=3100 ./run.sh # run the dev server on a different port
#
set -euo pipefail

# Always run from the repo root (the directory this script lives in), so it
# works no matter where it's invoked from.
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

echo "▶ Node $(node -v)  ·  npm $(npm -v)"

# 1. Environment file — the app reads secrets from .env.local. Seed it from the
#    committed example on first run so `next dev` boots even before you fill in
#    keys (the map + sample trips render without any keys; building a NEW trip
#    needs ANTHROPIC_API_KEY + GOOGLE_MAPS_API_KEY).
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "✓ Created .env.local from .env.example — add your API keys to build new trips."
else
  echo "✓ .env.local already present."
fi

# 2. Dependencies — install only when missing or out of date (package-lock
#    newer than the installed marker), so repeat runs start fast.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "▶ Installing dependencies…"
  npm install
else
  echo "✓ Dependencies up to date."
fi

# 3. `setup` subcommand stops here — deps + env only, no server.
if [ "${1:-}" = "setup" ]; then
  echo "✓ Setup complete. Run ./run.sh to start the dev server."
  exit 0
fi

# 4. Dev server.
echo "▶ Starting dev server on http://localhost:${PORT}"
exec npx next dev -p "${PORT}"
