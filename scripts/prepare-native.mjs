// The database engine (better-sqlite3) is a native module: the copy used by the tests runs on Node, but the installed program runs on Electron,
// which needs a differently built copy. This downloads the ready-made Electron build (no compiler needed) over the Node one, just before packaging.
// After running it, `npm rebuild better-sqlite3` restores the Node copy for the tests.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const dir = dirname(require.resolve('better-sqlite3/package.json'));
const prebuildBin = createRequire(join(dir, 'package.json')).resolve('prebuild-install/bin.js');
const arch = process.env.PACK_ARCH || 'x64';
console.log(`Fetching the Electron ${electronVersion} build of better-sqlite3 (${process.platform}-${arch})...`);
try {
  execFileSync(process.execPath, [prebuildBin, '--runtime', 'electron', '--target', electronVersion, '--arch', arch, '--platform', process.platform, '--force'], { cwd: dir, stdio: 'inherit' });
} catch {
  console.error('\nCould not download the ready-made database engine for this Electron version.\nIf you are packaging on your own computer, install the C++ build tools and run:  npx electron-rebuild -f -w better-sqlite3');
  process.exit(1);
}
console.log('ready.');
