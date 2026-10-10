#!/usr/bin/env bash
# Renders the Tapedeck PWA icons (SPEC T0 step 5) from icon.svg via SVG-to-PNG.
# Deterministic: flat vector shapes, ImageMagick only, no external service.
# Outputs are committed under web/public/icons/; re-run after editing icon.svg.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/../../web/public/icons"
mkdir -p "$OUT"

for size in 180 192 512; do
  magick -background none "$DIR/icon.svg" -resize "${size}x${size}" "png32:$OUT/icon-${size}.png"
done
mv "$OUT/icon-180.png" "$OUT/apple-touch-icon.png"
# The mark fits the maskable safe zone, so the maskable variant is the same design.
cp "$OUT/icon-512.png" "$OUT/icon-maskable-512.png"

magick identify "$OUT"/*.png
