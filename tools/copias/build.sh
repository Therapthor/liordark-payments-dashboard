#!/bin/bash
# Arma public/tools/copias.html: la librería age va DENTRO del archivo, así
# la herramienta funciona sin internet (abierta desde un USB, por ejemplo).
#   cd tools/copias && bash build.sh      (necesita: npx esbuild@0.24.2)
set -e
cd "$(dirname "$0")"
npx --yes esbuild@0.24.2 entry.mjs --bundle --format=iife --minify --legal-comments=none \
  --resolve-extensions=.mjs,.js --outfile=/tmp/age-bundle.js --log-level=warning \
  --alias:age-encryption=../../node_modules/age-encryption/dist/index.js
node -e '
const fs = require("fs");
const lib = fs.readFileSync("/tmp/age-bundle.js", "utf8").replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("template.html", "utf8").replace("/*AGE_LIB*/", () => lib);
fs.writeFileSync("../../public/tools/copias.html", html);
console.log("public/tools/copias.html", Math.round(html.length / 1024), "KB");
'
