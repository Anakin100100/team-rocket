#!/usr/bin/env bash
# Generate the Python (pydantic v2) client for the Rocket API from the live
# OpenAPI definition, using openapi-generator's `python` generator.
#
# Usage: scripts/generate-python-client.sh
#   ROCKET_API_KEY  admin API key (Settings → Security → API keys); falls back
#                   to the file ~/.config/rocket/api-key
#   ROCKET_API_URL  API origin (default: https://build-the-arsenal-team-rocket.com)
#
# Output: clients/python (package `rocket_client`) plus the spec it was built from.
set -euo pipefail

GENERATOR_VERSION=7.26.0
API_URL="${ROCKET_API_URL:-https://build-the-arsenal-team-rocket.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/clients/python"
KEY_FILE="$HOME/.config/rocket/api-key"
CACHE="$HOME/.cache/openapi-generator"
JAR="$CACHE/openapi-generator-cli-$GENERATOR_VERSION.jar"
MAVEN="https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/$GENERATOR_VERSION/openapi-generator-cli-$GENERATOR_VERSION.jar"

API_KEY="${ROCKET_API_KEY:-}"
if [[ -z "$API_KEY" && -f "$KEY_FILE" ]]; then
  API_KEY="$(tr -d '[:space:]' <"$KEY_FILE")"
fi
if [[ -z "$API_KEY" ]]; then
  echo "Set ROCKET_API_KEY or save an admin API key to $KEY_FILE." >&2
  exit 1
fi

if [[ ! -f "$JAR" ]]; then
  mkdir -p "$CACHE"
  curl -fsSL "$MAVEN" -o "$JAR.tmp"
  echo "$(curl -fsSL "$MAVEN.sha1")  $JAR.tmp" | sha1sum --check --quiet
  mv "$JAR.tmp" "$JAR"
fi

mkdir -p "$OUT"
SPEC="$OUT/openapi.json"
status="$(curl -sS -o "$SPEC.tmp" -w '%{http_code}' -H "x-api-key: $API_KEY" \
  "$API_URL/api/api-reference/openapi.json")"
if [[ "$status" != 200 ]]; then
  rm -f "$SPEC.tmp"
  echo "Fetching the OpenAPI definition from $API_URL failed (HTTP $status)." >&2
  echo "401/403: the key is missing, invalid or not an admin's. 404: that deployment predates the API-key release." >&2
  exit 1
fi
mv "$SPEC.tmp" "$SPEC"

java -jar "$JAR" generate \
  --generator-name python \
  --input-spec "$SPEC" \
  --output "$OUT" \
  --package-name rocket_client \
  --additional-properties projectName=rocket-client,packageVersion=1.0.0 \
  --skip-validate-spec >/dev/null

echo "Generated $OUT (package rocket_client) from $API_URL."
