/**
 * A minimal `npm` stand-in for build machines without a Node/npm installation.
 *
 * VegaAM's toolchain runs Node through Electron's bundled runtime
 * (`ELECTRON_RUN_AS_NODE=1`), and some build machines have no npm at all.
 * electron-builder however always asks the package manager for the
 * production dependency tree before it packages the application.
 *
 * VegaAM has **no runtime dependencies** (`"dependencies": {}` in
 * `package.json`); everything is bundled into `dist/` by esbuild. This shim
 * therefore reports exactly that - an empty production tree - which is the
 * truthful answer for this project.
 *
 * It is only used by the local packaging step (see `build/toolchain/npm.cmd`);
 * CI has a real npm and does not use it.
 */

const args = process.argv.slice(2);
const command = args[0] ?? '';

function readPackageJson() {
  try {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { name: 'vegaam', version: '0.0.0' };
  }
}

if (command === 'list') {
  const pkg = readPackageJson();
  // The exact shape `npm list --production --json` produces.
  console.log(
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      dependencies: {},
      problems: [],
    }),
  );
  process.exit(0);
}

if (command === 'config') {
  // `npm config list` is only used to detect the node linker layout.
  process.exit(0);
}

if (command === 'run' || command === 'rebuild' || command === 'ci' || command === 'install') {
  console.error(
    `[npm-shim] "npm ${command}" is not available in this toolchain. ` +
      'Use the build scripts in package.json instead.',
  );
  process.exit(1);
}

process.exit(0);
