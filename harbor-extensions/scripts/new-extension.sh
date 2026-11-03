#!/usr/bin/env bash
# Scaffold a new extension: scripts/new-extension.sh <name>   (lowercase-kebab, e.g. hello-world)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:-}"
[[ -n "$NAME" ]] || { echo "usage: $0 <name>   e.g. $0 hello-world" >&2; exit 2; }
[[ "$NAME" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] || { echo "FAIL: '$NAME' is not lowercase-kebab (letters, digits, single dashes; start with a letter)" >&2; exit 2; }
DEST="$REPO/extensions/$NAME"
[[ ! -e "$DEST" ]] || { echo "FAIL: extensions/$NAME already exists; pick another name" >&2; exit 1; }
cp -R "$REPO/templates/extension-template" "$DEST"
TITLE="$(echo "$NAME" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++)$i=toupper(substr($i,1,1)) substr($i,2)}1')"
sed -i.bak -e "s/^name: my-extension/name: $NAME/" -e "s/^title: My Extension/title: $TITLE/" "$DEST/extension.yaml"
sed -i.bak -e "s/My Extension/$TITLE/g" "$DEST/index.html"
rm -f "$DEST"/*.bak
cat <<OUT
Created extensions/$NAME
  Edit:  extensions/$NAME/extension.yaml  (owner, contact, description)
         extensions/$NAME/app.js, index.html, style.css
  Try:   make try EXT=$NAME
OUT
