/**
 * Application entry point for VegaAM 3.0 (Official-First Architecture).
 */

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { AppController } from './app';
import { repairWindowsIconIdentity } from './iconIdentity';

/**
 * The application name decides where the operating system keeps the
 * encryption key of `safeStorage`:
 *
 *   macOS   - a Keychain item named "<name> Safe Storage"
 *   Linux   - a key ring entry named "<name>"
 *   Windows - DPAPI (the name does not matter there)
 *
 * Electron resolves that name *before* the `ready` event is emitted, so it
 * has to be set here and never inside `whenReady()`.
 *
 * An unpackaged development run is a different binary than the signed
 * release build. On macOS it is therefore a different Keychain item, and
 * switching between the two would make macOS ask for Keychain permission
 * again and again. The development build therefore uses its own name - and,
 * with it, its own encrypted secret file - so the two never fight over a
 * file that the other cannot decrypt.
 */
app.setName(app.isPackaged ? 'VegaAM' : 'VegaAM Dev');
// Preserve the previous installation profile, including the official login partition.
const legacyProfile = join(app.getPath('appData'), 'SiriusXM Desktop');
app.setPath(
  'userData',
  process.env.VEGAAM_USER_DATA ||
    (existsSync(legacyProfile) ? legacyProfile : join(app.getPath('appData'), 'siriusxm-desktop')),
);
const userDataPath = app.getPath('userData');
const rendererDir = join(__dirname, '..', 'renderer');

const isPackaged = app.isPackaged;

let controller: AppController | undefined;

// Only one instance may run: the persistent player session belongs to it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    controller?.showMainWindow();
  });
}

app.setAppUserModelId('app.vegaam.desktop');

process.on('unhandledRejection', (reason) => {
  safeLog('[main] unhandled rejection:', reason);
});

/**
 * Keep an automated run from dying because the console went away.
 *
 * A detached Electron launcher leaves the application writing into a pipe that
 * has already been closed. Every `console.log` would then raise `EPIPE`, which
 * Electron reports with a **modal** error dialog - and that dialog blocks the
 * main thread, so the acceptance run silently stops. Automated modes
 * therefore write to a log file instead of the console.
 */
function redirectConsoleToFile(filePath: string): void {
  const write =
    (level: string) =>
    (...args: unknown[]): void => {
      try {
        const line = args
          .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
          .join(' ');
        appendFileSync(filePath, `${new Date().toISOString()} [${level}] ${line}\n`);
      } catch {
        /* logging must never break the run */
      }
    };
  console.log = write('log');
  console.info = write('info');
  console.warn = write('warn');
  console.error = write('error');
}

/** Serialise a value for the log without ever throwing. */
function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Write to the console without ever throwing.
 *
 * A detached launcher can leave the application writing into a pipe that has
 * already been closed; `console.log` then raises `EPIPE`, which would abort
 * an acceptance run with a native error dialog instead of a report.
 */
function safeLog(...args: unknown[]): void {
  try {
    console.log(...args);
  } catch {
    /* the console is gone - the runner keeps its own file log */
  }
}

/**
 * The icon file Windows should use for the VegaAM AppUserModelId.
 *
 * A packaged build points at its own executable, which embeds the V-star.
 * A development run points at the repository icon so the taskbar shows the
 * V-star instead of the stock Electron nucleus.
 */
function resolveWindowsIconUri(): string {
  if (!app.isPackaged) {
    const devIcon = join(app.getAppPath(), 'build', 'icon.ico');
    if (existsSync(devIcon)) return devIcon;
  }
  return app.getPath('exe');
}

app.whenReady()
  .then(async () => {
    // Automated runs must not depend on a console that may already be gone.
    if (
      process.argv.some((arg) =>
        [
          '--smoke',
          '--verify-official-first',
          '--live-probe',
          '--qa-3-1',
          '--qa-3-2',
          '--qa-threshold',
          '--lastfm-acceptance',
          '--lastfm-restore-check',
        ].includes(arg),
      )
    ) {
      redirectConsoleToFile(join(userDataPath, 'vegaam-automated.log'));
    }

    // Repair the Windows icon identity before the first window is created.
    //
    // A shortcut that advertises `app.vegaam.desktop` while pointing at an
    // Electron binary makes Windows draw the stock nucleus in the taskbar,
    // even though the executable and the window both carry the V-star.
    if (process.platform === 'win32') {
      try {
        const identity = repairWindowsIconIdentity({ iconUri: resolveWindowsIconUri() });
        safeLog(
          '[icon-identity] aumid=' +
            identity.aumid +
            ' registered=' +
            String(identity.aumidRegistered) +
            ' removedSquatters=' +
            (identity.removedSquatters.length > 0 ? identity.removedSquatters.join(', ') : 'none') +
            ' errors=' +
            (identity.errors.length > 0 ? identity.errors.join('; ') : 'none'),
        );
      } catch (error) {
        safeLog('[icon-identity] repair failed:', String(error));
      }
    }

    controller = new AppController(userDataPath, rendererDir);
    await controller.init();

    // Prevent DevTools from opening in packaged builds while keeping the native
    // application menu and keyboard accelerators active.
    if (isPackaged) {
      app.on('web-contents-created', (_event, contents) => {
        contents.on('devtools-opened', () => contents.closeDevTools());
      });
    }

    app.on('activate', () => {
      controller?.showMainWindow();
    });

    if (process.argv.includes('--qa-3-2') || process.argv.includes('--qa-3-1')) {
      const { runQa31 } = await import('./qa31');
      const defaultFolder = process.argv.includes('--qa-3-2')
        ? 'v3.2-acceptance'
        : 'v3.1-acceptance';
      const outputDir =
        process.env.VEGAAM_QA_OUTPUT ||
        join(__dirname, '..', '..', 'artifacts', defaultFolder);
      try {
        const files = await runQa31(controller, outputDir);
        console.log('[qa-3-2] captured:', files.join(', '));
      } catch (error) {
        console.error('[qa-3-2] failed:', error);
        process.exitCode = 1;
      } finally {
        controller?.shutdown();
        app.quit();
      }
      return;
    }

    if (process.argv.includes('--lastfm-acceptance') || process.argv.includes('--lastfm-restore-check')) {
      const { runLastFmAcceptance, runLastFmRestoreCheck } = await import('./lastfmAcceptance');
      const restoreOnly = process.argv.includes('--lastfm-restore-check');
      const outputDir =
        process.env.VEGAAM_QA_OUTPUT ||
        join(__dirname, '..', '..', 'artifacts', 'lastfm-acceptance');
      try {
        const result = restoreOnly
          ? await runLastFmRestoreCheck(controller, outputDir)
          : await runLastFmAcceptance(controller, outputDir);
        safeLog(
          `[lastfm-acceptance] ok=${String(result.ok)} account=${result.account ?? 'none'} ` +
            `state=${result.connectionState ?? 'unknown'} ` +
            `error=${result.lastError ?? 'none'}`,
        );
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        safeLog('[lastfm-acceptance] failed:', String(error));
        process.exitCode = 1;
      } finally {
        controller?.shutdown();
        app.quit();
      }
      return;
    }

    if (process.argv.includes('--qa-threshold')) {
      const { runQaThreshold } = await import('./qaThreshold');
      const outputDir =
        process.env.VEGAAM_QA_OUTPUT ||
        join(__dirname, '..', '..', 'artifacts', 'v3.2.1-threshold-acceptance');
      try {
        const files = await runQaThreshold(controller, outputDir);
        safeLog('[qa-threshold] captured:', files.join(', '));
      } catch (error) {
        safeLog('[qa-threshold] failed:', String(error));
        process.exitCode = 1;
      } finally {
        controller?.shutdown();
        app.quit();
      }
      return;
    }

    if (process.argv.includes('--live-probe')) {
      const { runLiveProbe } = await import('./liveProbe');
      try {
        await runLiveProbe(
          controller,
          process.env.VEGAAM_QA_OUTPUT || join(__dirname, '..', '..', 'artifacts', 'v3-acceptance'),
        );
      } finally {
        controller.shutdown();
        app.quit();
      }
      return;
    }

    if (process.argv.includes('--smoke') || process.argv.includes('--verify-official-first')) {
      const { runSmoke } = await import('./smoke');
      const outputDir =
        process.env.VEGAAM_SMOKE_OUTPUT ||
        join(
          __dirname,
          '..',
          '..',
          process.argv.includes('--verify-official-first')
            ? 'artifacts/v3-acceptance'
            : 'artifacts',
        );
      try {
        const files = await runSmoke(controller, outputDir);
        console.log('[smoke] captured:', files.join(', '));
      } catch (error) {
        console.error('[smoke] failed:', error);
        process.exitCode = 1;
      } finally {
        controller?.shutdown();
        app.quit();
      }
    }
  })
  .catch((error) => {
    console.error('[main] the application could not be started:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  controller?.shutdown();
});
