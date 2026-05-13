#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
out="results.json"
echo "[" > "$out"
node -e "
const p = require('./platforms.json');
(async () => {
  for (const x of p) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('node', ['./score-docs.mjs', x.name, x.url1, x.url2], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('FAILED for', x.name, r.stderr);
      process.exit(1);
    }
    process.stdout.write(r.stdout.trim());
    if (x !== p[p.length - 1]) process.stdout.write(',\n');
    else process.stdout.write('\n');
  }
})();
" >> "$out"
echo "]" >> "$out"
echo "wrote $out"
