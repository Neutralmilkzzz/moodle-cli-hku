#!/bin/sh
set -eu
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=hku-darwin-arm64 ;;
  Linux-x86_64) asset=hku-linux-x64 ;;
  *) echo 'Use npm install -g hku-cli on this platform.' >&2; exit 1 ;;
esac
root=${HKU_INSTALL_DIR:-${MOODLE_INSTALL_DIR:-"$HOME/.local/bin"}}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
version=${HKU_VERSION:-${MOODLE_VERSION:-latest}}
if [ "$version" = latest ]; then
  base=https://github.com/Neutralmilkzzz/moodle-cli-hku/releases/latest/download
else
  case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo 'HKU_VERSION must be a release tag such as v0.13.0.' >&2; exit 1 ;; esac
  base="https://github.com/Neutralmilkzzz/moodle-cli-hku/releases/download/$version"
fi
curl -fL --retry 2 "$base/$asset" -o "$temporary/hku"
chmod 755 "$temporary/hku"
"$temporary/hku" --version
mkdir -p "$root"
install -m 755 "$temporary/hku" "$root/hku"
printf 'Installed %s/hku. Add %s to PATH if needed.\n' "$root" "$root"
