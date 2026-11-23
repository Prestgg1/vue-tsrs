#!/usr/bin/env bash
# Recreate the dependency-locked projects used in docs/parity/README.md.
set -euo pipefail

if [[ $# != 1 ]]; then
  echo 'Usage: bash scripts/bench/setup-projects.sh <new-work-directory>' >&2
  exit 2
fi

bench=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -- "$1"
cd -- "$1"

npm exec --yes --package=create-vite@8.2.0 -- create-vite vite --template vue-ts --no-interactive
git clone --quiet --no-checkout https://github.com/kittors/simple-sheet.git sheet
git -C sheet checkout --quiet --detach 8def7751e7ce4a74e1b4b260bf01d7e9aa9befcc
git clone --quiet --no-checkout https://github.com/nuxt/starter.git nuxt
git -C nuxt checkout --quiet --detach 13659102e9c35042f8c56e5d9deb3e1bd8c96fac

for name in vite sheet nuxt; do
  (
    cd -- "$name"
    npm pkg set 'devDependencies.vue-tsc=3.2.9' 'devDependencies.typescript=6.0.3'
    gzip -dc -- "$bench/locks/$name.json.gz" > package-lock.json
    npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
  )
done
(cd nuxt && npm exec --offline -- nuxt prepare)
