#!/bin/bash
# Builds a signed, notarized Explr DMG that opens on any Mac without Gatekeeper warnings.
#
# One-time setup (done by you, credentials never pass through this script):
#   1. A "Developer ID Application" certificate in your login keychain
#      (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application).
#   2. A notarytool keychain profile:
#        xcrun notarytool store-credentials explr-notary \
#          --apple-id <your Apple ID> --team-id <TEAMID>
#      (it asks for an app-specific password from account.apple.com and stores it in the keychain)
#
# Usage:
#   DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)" scripts/release-macos.sh
#   Optional: NOTARY_PROFILE (default explr-notary), SKIP_NOTARIZE=1 for a signed-only test build.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${DEVELOPER_ID:?Set DEVELOPER_ID to your 'Developer ID Application: ...' identity (see: security find-identity -v -p codesigning)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-explr-notary}"
ENTITLEMENTS="src-tauri/entitlements.plist"

if ! security find-identity -v -p codesigning | grep -Fq "$DEVELOPER_ID"; then
    echo "Signing identity not found in the keychain: $DEVELOPER_ID" >&2
    exit 1
fi

TARGET_DIR="$(cargo metadata --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
BUNDLE_DIR="$TARGET_DIR/release/bundle"
APP="$BUNDLE_DIR/macos/Explr.app"
VERSION="$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
OUT_DIR="dist-builds"
DMG="$OUT_DIR/Explr-$VERSION-$(uname -m).dmg"

echo "==> Building Explr $VERSION"
npx tauri build --bundles app

echo "==> Signing with hardened runtime ($DEVELOPER_ID)"
# Sign nested code first, then the app itself
find "$APP/Contents" -type f \( -perm -u+x -o -name "*.dylib" \) ! -path "*/MacOS/*" -print0 2>/dev/null \
    | xargs -0 -I{} codesign --force --timestamp --options runtime --sign "$DEVELOPER_ID" {} 2>/dev/null || true
codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$DEVELOPER_ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Creating DMG"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Explr" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
codesign --force --timestamp --sign "$DEVELOPER_ID" "$DMG"

if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
    echo "==> Skipping notarization (SKIP_NOTARIZE=1). Signed DMG: $DMG"
    exit 0
fi

echo "==> Notarizing (this usually takes a few minutes)"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> Stapling the notarization ticket"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG" || true

echo "Done: $DMG"
