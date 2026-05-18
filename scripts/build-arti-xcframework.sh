#!/bin/bash
set -euo pipefail

# Use rustup toolchain (not Homebrew) — required for iOS cross-compilation targets
export PATH="$HOME/.cargo/bin:$PATH"

#
# Build arti.xcframework with onion-service-client feature enabled.
#
# Prerequisites:
#   brew install rustup cbindgen
#   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
#
# Usage:
#   ./scripts/build-arti-xcframework.sh
#
# Output:
#   modules/tor-proxy/ios/arti.xcframework
#

ARTI_MOBILE_VERSION="arti-1.7.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ROOT_DIR/modules/tor-proxy/ios"

BUILDDIR="$(mktemp -d)"
echo "Build dir: $BUILDDIR"

# Download arti-mobile-ex source via archive (no git auth needed)
echo "=== Downloading arti-mobile-ex ($ARTI_MOBILE_VERSION)..."
curl -sL "https://gitlab.com/guardianproject/tormobile/arti-mobile-ex/-/archive/$ARTI_MOBILE_VERSION/arti-mobile-ex-$ARTI_MOBILE_VERSION.tar.gz" \
  | tar xz -C "$BUILDDIR"

SOURCE="$BUILDDIR/arti-mobile-ex-$ARTI_MOBILE_VERSION"

if [ ! -f "$SOURCE/common/Cargo.toml" ]; then
  echo "ERROR: Source not found at $SOURCE/common/Cargo.toml"
  exit 1
fi

# Patch Cargo.toml to add onion-service-client feature
echo "=== Patching Cargo.toml to enable onion-service-client..."
cd "$SOURCE/common"

sed -i '' \
  's|features = \["async-std", "dns-proxy", "static-sqlite", "rustls", "pt-client", "experimental-api"\]|features = ["async-std", "dns-proxy", "static-sqlite", "rustls", "pt-client", "experimental-api", "onion-service-client"]|' \
  Cargo.toml

sed -i '' \
  's|features = \["static-sqlite", "rustls", "pt-client"\]|features = ["static-sqlite", "rustls", "pt-client", "onion-service-client"]|' \
  Cargo.toml

echo "Patched Cargo.toml:"
grep "onion-service-client" Cargo.toml

# Patch lib.rs to enable allow_onion_addrs.
# The client_config_builder has address_filter() which controls .onion filtering.
echo "=== Patching lib.rs to enable allow_onion_addrs..."
sed -i '' 's|let mut client_config_builder = TorClientConfigBuilder::from_directories(state_dir, cache_dir);|let mut client_config_builder = TorClientConfigBuilder::from_directories(state_dir, cache_dir); client_config_builder.address_filter().allow_onion_addrs(true);|' src/lib.rs
grep "allow_onion_addrs" src/lib.rs || echo "WARNING: patch not applied"

# Build function
build_target() {
  local RUST_TARGET=$1
  local LABEL=$2

  echo "=== Building for $LABEL ($RUST_TARGET)..."

  cd "$SOURCE/common"

  export IPHONEOS_DEPLOYMENT_TARGET=15.0
  export MACOSX_DEPLOYMENT_TARGET=11.0

  cargo build \
    --target "$RUST_TARGET" \
    --release \
    --target-dir "$BUILDDIR/build-$RUST_TARGET"

  mkdir -p "$BUILDDIR/lib-$RUST_TARGET"
  cp "$BUILDDIR/build-$RUST_TARGET/$RUST_TARGET/release/libarti_mobile_ex.a" \
     "$BUILDDIR/lib-$RUST_TARGET/"
}

# Build for all iOS targets
build_target "aarch64-apple-ios"     "iOS device (arm64)"
build_target "aarch64-apple-ios-sim" "iOS simulator (arm64)"
build_target "x86_64-apple-ios"      "iOS simulator (x86_64)"

# Create fat binary for simulator (arm64 + x86_64)
echo "=== Creating fat simulator binary..."
mkdir -p "$BUILDDIR/lib-sim-fat"
lipo \
  -arch arm64  "$BUILDDIR/lib-aarch64-apple-ios-sim/libarti_mobile_ex.a" \
  -arch x86_64 "$BUILDDIR/lib-x86_64-apple-ios/libarti_mobile_ex.a" \
  -create -output "$BUILDDIR/lib-sim-fat/libarti_mobile_ex.a"

# Generate C header
echo "=== Generating header..."
cd "$SOURCE/common"
cbindgen --lang c --output "$BUILDDIR/arti-mobile.h" src/apple.rs

# Create framework bundles
create_framework() {
  local SDK=$1
  local LIB_PATH=$2

  local FW_DIR="$BUILDDIR/$SDK/arti.framework"
  rm -rf "$FW_DIR"
  mkdir -p "$FW_DIR/Headers"

  cp "$LIB_PATH" "$FW_DIR/arti"
  cp "$BUILDDIR/arti-mobile.h" "$FW_DIR/Headers/"

  cat > "$FW_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>arti</string>
  <key>CFBundleIdentifier</key><string>org.torproject.arti</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>arti</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>1.7.0</string>
  <key>CFBundleVersion</key><string>1.7.0</string>
</dict>
</plist>
EOF
}

echo "=== Creating frameworks..."
create_framework "iphoneos"        "$BUILDDIR/lib-aarch64-apple-ios/libarti_mobile_ex.a"
create_framework "iphonesimulator" "$BUILDDIR/lib-sim-fat/libarti_mobile_ex.a"

# Create xcframework
echo "=== Creating xcframework..."
rm -rf "$OUTPUT_DIR/arti.xcframework"

xcodebuild -create-xcframework \
  -framework "$BUILDDIR/iphoneos/arti.framework" \
  -framework "$BUILDDIR/iphonesimulator/arti.framework" \
  -output "$OUTPUT_DIR/arti.xcframework"

echo ""
echo "=== Done! Output: $OUTPUT_DIR/arti.xcframework"
echo ""

# Verify onion-service-client is compiled in
if strings "$OUTPUT_DIR/arti.xcframework/ios-arm64_x86_64-simulator/arti.framework/arti" | grep -q "onion-service-client not compiled"; then
  echo "WARNING: onion-service-client feature NOT detected in binary!"
else
  echo "OK: onion-service-client feature appears to be compiled in"
fi

# Cleanup
rm -rf "$BUILDDIR"
echo "Build dir cleaned up."
