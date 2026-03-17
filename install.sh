#!/bin/bash
set -euo pipefail

REPO="collaborator-ai/collab-public"
INSTALL_DIR="/Applications"
TMP_DIR=$(mktemp -d)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# Check for required commands
for cmd in curl ditto shasum; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: required command '$cmd' not found." >&2
    exit 1
  fi
done

# Use jq if available for robust JSON parsing, otherwise fall back to grep/cut
use_jq=false
if command -v jq &>/dev/null; then
  use_jq=true
fi

echo "Fetching latest release info..."
if [ "$use_jq" = true ]; then
  RELEASE_DATA=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
  ZIP_URL=$(echo "$RELEASE_DATA" | jq -r '.assets[] | select(.name | endswith("arm64-mac.zip")) | .browser_download_url' | head -1)
  TAG_NAME=$(echo "$RELEASE_DATA" | jq -r '.tag_name')
else
  API_RESPONSE=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
  ZIP_URL=$(echo "$API_RESPONSE" \
    | grep -o '"browser_download_url": *"[^"]*arm64-mac\.zip"' \
    | head -1 \
    | cut -d'"' -f4)
  TAG_NAME=$(echo "$API_RESPONSE" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -1 \
    | cut -d'"' -f4)
fi

if [ -z "$ZIP_URL" ]; then
  echo "Error: could not find a macOS ARM64 zip in the latest release." >&2
  exit 1
fi

if [ -z "$TAG_NAME" ]; then
  echo "Error: could not determine release tag." >&2
  exit 1
fi

# Fetch the YAML file containing SHA512 hash
YAML_URL="https://github.com/${REPO}/releases/download/${TAG_NAME}/latest-mac.yml"
echo "Fetching checksums from ${YAML_URL}..."
YAML_CONTENT=$(curl -fsSL "$YAML_URL") || {
  echo "Warning: could not fetch checksums file, skipping integrity check." >&2
  YAML_CONTENT=""
}

EXPECTED_SHA512=""
if [ -n "$YAML_CONTENT" ]; then
  # Extract SHA512 from YAML (format: sha512: <base64_hash>)
  EXPECTED_SHA512=$(echo "$YAML_CONTENT" | grep -E '^sha512:' | awk '{print $2}' | tr -d ' ')
fi

ZIP_NAME=$(basename "$ZIP_URL")
echo "Downloading ${ZIP_NAME}..."
curl -fSL --progress-bar "$ZIP_URL" -o "$TMP_DIR/Collaborator.zip"

# Verify SHA512 if we have it
if [ -n "$EXPECTED_SHA512" ]; then
  echo "Verifying download integrity..."
  ACTUAL_SHA512=$(shasum -a 512 "$TMP_DIR/Collaborator.zip" | awk '{print $1}')

  # Convert hex to base64 for comparison (YAML uses base64)
  EXPECTED_SHA512_HEX=$(echo "$EXPECTED_SHA512" | base64 -d | xxd -p -c 256)

  if [ "$ACTUAL_SHA512" != "$EXPECTED_SHA512_HEX" ]; then
    echo "Error: SHA512 verification failed!" >&2
    echo "Expected: $EXPECTED_SHA512_HEX" >&2
    echo "Actual:   $ACTUAL_SHA512" >&2
    echo "The download may be corrupted or tampered with." >&2
    exit 1
  fi
  echo "Integrity check passed."
fi

echo "Installing to ${INSTALL_DIR}..."
ditto -xk "$TMP_DIR/Collaborator.zip" "$INSTALL_DIR"

echo "Done. Opening Collaborator..."
open "$INSTALL_DIR/Collaborator.app"
