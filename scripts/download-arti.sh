#!/bin/bash
set -euo pipefail

#
# Download the pre-built arti.xcframework from GitHub Releases.
#
# This framework includes Arti 1.7.0 with onion-service-client + allow_onion_addrs
# enabled at compile time. Built via scripts/build-arti-xcframework.sh
#
# Usage:
#   ./scripts/download-arti.sh
#
# The script is idempotent — skips download if the framework already exists.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ROOT_DIR/modules/tor-proxy/ios"
FRAMEWORK_DIR="$OUTPUT_DIR/arti.xcframework"

# GitHub Release URL — update when uploading a new version
RELEASE_TAG="tor-arti-1.7.0"
REPO="tillit-cc/tillit-app"
ASSET_NAME="arti.xcframework.zip"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG/$ASSET_NAME"

# SHA256 checksum of the expected zip — update when uploading a new release
EXPECTED_SHA256="215508d176e10ae46bab66ce822b196513b3f0e70b1a7550c6a73c4bac911c1e"

# Skip if already present
if [ -d "$FRAMEWORK_DIR" ] && [ -f "$FRAMEWORK_DIR/ios-arm64/arti.framework/arti" ]; then
  echo "[download-arti] arti.xcframework already exists, skipping download"
  exit 0
fi

echo "[download-arti] Downloading arti.xcframework from $DOWNLOAD_URL ..."

TMPFILE=$(mktemp /tmp/arti-xcframework-XXXXXX.zip)

curl -fSL "$DOWNLOAD_URL" -o "$TMPFILE" || {
  echo ""
  echo "ERROR: Failed to download arti.xcframework."
  echo ""
  echo "You can build it locally instead:"
  echo "  ./scripts/build-arti-xcframework.sh"
  echo ""
  echo "Prerequisites: Rust toolchain with iOS targets"
  echo "  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios"
  echo ""
  rm -f "$TMPFILE"
  exit 1
}

# Verify SHA256 checksum
echo "[download-arti] Verifying SHA256 checksum..."
echo "$EXPECTED_SHA256  $TMPFILE" | shasum -a 256 -c - || {
  echo ""
  echo "ERROR: SHA256 checksum verification failed!"
  echo "Expected: $EXPECTED_SHA256"
  echo "Got:      $(shasum -a 256 "$TMPFILE" | cut -d' ' -f1)"
  echo ""
  echo "The downloaded file may be corrupted or tampered with."
  echo "If a new version was released, update EXPECTED_SHA256 in this script."
  echo ""
  rm -f "$TMPFILE"
  exit 1
}

echo "[download-arti] Extracting..."
rm -rf "$FRAMEWORK_DIR"
unzip -q "$TMPFILE" -d "$OUTPUT_DIR"
rm -f "$TMPFILE"

# Verify
if [ -d "$FRAMEWORK_DIR" ]; then
  echo "[download-arti] OK: $(du -sh "$FRAMEWORK_DIR" | cut -f1) extracted"
else
  echo "ERROR: Extraction failed — arti.xcframework not found after unzip"
  exit 1
fi
