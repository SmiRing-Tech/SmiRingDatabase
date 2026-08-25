#!/bin/sh
# Renders livekit.yaml.template -> livekit.yaml, filling in the deploy-specific values
# from .env. Run this once after editing .env, and again any time .env changes
# (LIVEKIT_API_KEY rotated, backend URL changed, etc). Re-run before `docker compose up`.
#
# livekit.yaml itself is gitignored — it's a generated file, not a source of truth.
# Edit livekit.yaml.template instead.

set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "error: .env not found (copy .env.example to .env and fill in real values first)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

for var in LIVEKIT_API_KEY BACKEND_WEBHOOK_HOST; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "error: $var is not set in .env" >&2
    exit 1
  fi
done

envsubst '${LIVEKIT_API_KEY} ${BACKEND_WEBHOOK_HOST}' < livekit.yaml.template > livekit.yaml
echo "wrote livekit.yaml from livekit.yaml.template"
