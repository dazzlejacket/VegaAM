#!/usr/bin/env node
/**
 * electron-builder CLI wrapper.
 *
 * VegaAM's toolchain runs Node through Electron's bundled runtime
 * (`ELECTRON_RUN_AS_NODE=1`) because a standalone Node is not installed on
 * every build machine. Under that mode `process.versions.electron` is set, so
 * yargs' `hideBin()` assumes it is running a *bundled Electron app* and slices
 * `process.argv` at index 1 instead of index 2. The CLI then sees its own
 * script path as an unknown argument and aborts.
 *
 * Setting `process.defaultApp = true` restores the standard Node argv layout,
 * so `hideBin()` slices at index 2 as intended.
 */
process.defaultApp = true;

/**
 * Disable Electron's ASAR path interception.
 *
 * Under `ELECTRON_RUN_AS_NODE` Electron still patches `fs`, and every path
 * that contains a `.asar` component is treated as "a file inside an ASAR
 * archive". electron-builder copies `resources/default_app.asar` into the
 * packaged application, so the patched `open()` tries to read
 * `resources/default_app` as an archive and fails with
 * "Invalid package ... resources\default_app.asar".
 *
 * `process.noAsar = true` turns the interception off, so the file is copied
 * like any other file.
 */
process.noAsar = true;

require('electron-builder/cli.js');
