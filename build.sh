#!/bin/sh
set -eu

rm -rf dist
mkdir -p dist/server dist/.openai
cp price.html dist/price.html

node <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('price.html', 'utf8');
const server = `const html = ${JSON.stringify(html)};

export default {
  async fetch() {
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
};
`;
fs.writeFileSync('dist/server/index.js', server);
NODE

cat > dist/.openai/hosting.json <<'EOF'
{
  "project_id": "appgprj_6a622156c42c819197b8bd631dcac730"
}
EOF
