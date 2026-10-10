#!/usr/bin/env bash
set -euo pipefail

ipa=${1:?usage: prepare-ios-trollstore-icons.sh path/to/app.ipa}
ipa="$(cd "$(dirname "$ipa")" && pwd)/$(basename "$ipa")"
source_icon=${2:-"$(cd "$(dirname "$0")/.." && pwd)/src-tauri/icons/ios/AppIcon-512@2x.png"}

test -s "$ipa"
test -s "$source_icon"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unzip -q "$ipa" -d "$work"
app=$(find "$work/Payload" -maxdepth 1 -type d -name '*.app' -print -quit)
test -n "$app"
test -s "$app/Assets.car"

make_icon() {
  local name=$1
  local size=$2
  sips -s format png -z "$size" "$size" "$source_icon" --out "$app/$name.png" >/dev/null
  test "$(sips -g pixelWidth "$app/$name.png" | awk '/pixelWidth/{print $2}')" = "$size"
  test "$(sips -g pixelHeight "$app/$name.png" | awk '/pixelHeight/{print $2}')" = "$size"
  if sips -g hasAlpha "$app/$name.png" | grep -q 'yes'; then
    echo "iOS legacy icon unexpectedly contains an alpha channel: $name.png" >&2
    exit 1
  fi
}

make_icon AppIcon20x20@2x 40
make_icon AppIcon20x20@3x 60
make_icon AppIcon29x29@2x 58
make_icon AppIcon29x29@3x 87
make_icon AppIcon40x40@2x 80
make_icon AppIcon40x40@3x 120
make_icon AppIcon60x60@2x 120
make_icon AppIcon60x60@3x 180
make_icon AppIcon20x20~ipad 20
make_icon AppIcon20x20@2x~ipad 40
make_icon AppIcon29x29~ipad 29
make_icon AppIcon29x29@2x~ipad 58
make_icon AppIcon40x40~ipad 40
make_icon AppIcon40x40@2x~ipad 80
make_icon AppIcon76x76~ipad 76
make_icon AppIcon76x76@2x~ipad 152
make_icon AppIcon83.5x83.5@2x~ipad 167

info="$app/Info.plist"
plist=/usr/libexec/PlistBuddy

set_icon_dictionary() {
  local key=$1
  shift
  "$plist" -c "Delete :$key" "$info" >/dev/null 2>&1 || true
  "$plist" -c "Add :$key dict" "$info"
  "$plist" -c "Add :$key:CFBundlePrimaryIcon dict" "$info"
  "$plist" -c "Add :$key:CFBundlePrimaryIcon:CFBundleIconName string AppIcon" "$info"
  "$plist" -c "Add :$key:CFBundlePrimaryIcon:CFBundleIconFiles array" "$info"
  local index=0
  for name in "$@"; do
    "$plist" -c "Add :$key:CFBundlePrimaryIcon:CFBundleIconFiles:$index string $name" "$info"
    index=$((index + 1))
  done
}

set_icon_dictionary CFBundleIcons \
  AppIcon20x20 AppIcon29x29 AppIcon40x40 AppIcon60x60
set_icon_dictionary 'CFBundleIcons~ipad' \
  AppIcon20x20 AppIcon29x29 AppIcon40x40 AppIcon76x76 AppIcon83.5x83.5

rm -f "$ipa"
(
  cd "$work"
  zip -qry "$ipa" Payload
)
