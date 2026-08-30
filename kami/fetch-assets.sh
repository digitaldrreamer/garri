#!/bin/sh
# Kami's demo documents and the fonts they reference.
#
# The fonts are 53MB of third-party CJK faces and are not vendored here; this
# fetches them from tw93/Kami, where they carry their own licences.
set -e
cd "$(dirname "$0")"
mkdir -p demos images fonts
for f in $(gh api repos/tw93/Kami/contents/assets/demos \
    -q '.[] | select(.type=="file") | select(.name|endswith(".html") or endswith(".jpg")) | .name'); do
  gh api "repos/tw93/Kami/contents/assets/demos/$f" -q .download_url | xargs curl -sSL -o "demos/$f"
done
gh api repos/tw93/Kami/contents/assets/demos/images -q '.[] | .name + " " + .download_url' \
  | while read -r n u; do curl -sSL -o "images/$n" "$u"; done
gh api repos/tw93/Kami/contents/assets/fonts -q '.[] | .name + " " + (.download_url // "")' \
  | while read -r n u; do [ -n "$u" ] && curl -sSL -o "fonts/$n" "$u"; done
echo "fetched $(ls demos/*.html | wc -l) demos and $(ls fonts | wc -l) font files"
