#!/bin/sh
# extract-domain.sh <mixin-name> <extended-regex>
# Lists the methods still on the class body that match, then extracts them.
set -e
NAME="$1"; PAT="$2"
grep -n '^        \(async \)\?[a-zA-Z_$][a-zA-Z0-9_$]*(' src/js/paint-engine.js \
  | sed 's/^\([0-9]*\):  *\(async \)\?\([a-zA-Z_$][a-zA-Z0-9_$]*\)(.*/\3/' \
  | grep -vE '^(if|for|while|switch|catch|return|else|do)$' \
  | sort -u > /tmp/pool.txt
grep -E "$PAT" /tmp/pool.txt > /tmp/take.txt || true
COUNT=$(wc -l < /tmp/take.txt)
echo "== $NAME: $COUNT methods =="
tr '\n' ' ' < /tmp/take.txt; echo
[ "$COUNT" -gt 0 ] || { echo "nothing matched"; exit 1; }
node scripts/extract-methods.mjs "$NAME" $(cat /tmp/take.txt)
node --check "src/js/$NAME.js"
