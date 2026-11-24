// Builds the program: the main process, the preload script and the window (renderer) into dist/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, logLevel: 'warning', sourcemap: false, legalComments: 'none' };
await build({ ...common, entryPoints: ['src/main/main.ts'], platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/main/main.cjs', external: ['electron', 'better-sqlite3', '@node-rs/argon2'] });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/preload/preload.cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/index.tsx'], platform: 'browser', target: 'chrome120', format: 'iife', jsx: 'automatic', minify: true, outfile: 'dist/renderer/app.js', define: { 'process.env.NODE_ENV': '"production"' } });
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/style.css', 'dist/renderer/style.css');
console.log('built dist/');
