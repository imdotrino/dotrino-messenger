#!/usr/bin/env bash
# Build a zip of the extension ready for Web Store upload.
# Excludes documentation, git, and the zip itself so the upload is minimal.

set -e
cd "$(dirname "$0")"

OUT="../../cc-messenger-extension-$(node -e "console.log(require('./manifest.json').version)").zip"
rm -f "$OUT"

zip -r "$OUT" . \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "*.zip" \
  -x "PRIVACY.md" \
  -x "PERMISSIONS.md" \
  -x "STORE_LISTING.md" \
  -x "SUBMISSION.md" \
  -x "package-extension.sh" \
  -x "package-extension.ps1"

echo "✅ Wrote $OUT ($(wc -c < "$OUT") bytes)"
