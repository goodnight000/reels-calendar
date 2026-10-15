import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export default defineConfig({ plugins: [react(), {
  name: 'gzip-static',
  // Precompress once at build time; never spend the request path compressing JS.
  writeBundle({ dir }, bundle) {
    for (const [name, item] of Object.entries(bundle)) {
      if (!/\.(js|css|html)$/.test(name)) continue;
      writeFileSync(path.join(dir, `${name}.gz`), gzipSync(item.type === 'chunk' ? item.code : item.source));
    }
  },
}] });
