#!/bin/sh
set -eu

rm -rf dist
mkdir -p dist/server dist/.openai
cp price.html dist/price.html

cat > dist/server/index.js <<'EOF'
import fs from 'node:fs/promises';

const html = await fs.readFile(new URL('../price.html', import.meta.url), 'utf8');

export default {
  async fetch() {
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
EOF

cat > dist/.openai/hosting.json <<'EOF'
{
  "project_id": "appgprj_6a622156c42c819197b8bd631dcac730"
}
EOF
