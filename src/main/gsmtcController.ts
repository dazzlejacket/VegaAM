/**
 * Capability-gated Windows GSMTC (GlobalSystemMediaTransportControls) adapter.
 *
 * Uses the supported Windows Runtime API (Windows.Media.Control) via a bounded
 * PowerShell helper on Windows to inspect and invoke OS media session controls
 * published by Chromium's MediaSession implementation, without ever touching
 * the official SiriusXM DOM.
 *
 * When a transport capability is unavailable (or on platforms without an active
 * OS media session), the capability flag is false and companion windows hide
 * the unsupported control rather than rendering a dead button.
 */

import { execFile } from 'node:child_process';

import type { PlaybackCapabilities } from '../shared/types';

export interface GsmtcProbeState {
  sessionFound: boolean;
  sourceAppUserModelId: string | null;
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
}

const DEFAULT_PROBE: GsmtcProbeState = {
  sessionFound: false,
  sourceAppUserModelId: null,
  canPlayPause: false,
  canNext: false,
  canPrevious: false,
};

/**
 * Pure capability builder used by AppController and unit tests.
 */
export function buildPlaybackCapabilities(input: {
  platform?: NodeJS.Platform;
  isMuted: boolean;
  gsmtc?: GsmtcProbeState | null;
  mprisActive?: boolean;
}): PlaybackCapabilities {
  const platform = input.platform ?? process.platform;
  const gsmtc = input.gsmtc ?? DEFAULT_PROBE;

  if (platform === 'win32' && gsmtc.sessionFound && (gsmtc.canPlayPause || gsmtc.canNext || gsmtc.canPrevious)) {
    return {
      canPlayPause: Boolean(gsmtc.canPlayPause),
      canNext: Boolean(gsmtc.canNext),
      canPrevious: Boolean(gsmtc.canPrevious),
      canMute: true,
      isMuted: Boolean(input.isMuted),
      controlSource: 'gsmtc',
    };
  }

  return {
    canPlayPause: false,
    canNext: false,
    canPrevious: false,
    canMute: true,
    isMuted: Boolean(input.isMuted),
    controlSource: 'webcontents-mute',
  };
}

function buildPowerShellScript(action: 'probe' | 'play' | 'pause' | 'toggle' | 'next' | 'previous', matchHint?: string): string {
  const safeHint = (matchHint ?? '').replace(/'/g, "''").slice(0, 80);
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await-WinRt($op, [Type]$resultType) {
  $method = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $method.Invoke($null, @($op))
  $task.Wait(2500) | Out-Null
  return $task.Result
}
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await-WinRt ($mgrType::RequestAsync()) $mgrType
$sessions = $mgr.GetSessions()
$target = $null
$hint = '${safeHint}'
foreach ($s in $sessions) {
  $id = [string]$s.SourceAppUserModelId
  if ($id -match 'vegaam|electron') {
    $target = $s
    break
  }
  if ($hint -and -not $target) {
    try {
      $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
      $props = Await-WinRt ($s.TryGetMediaPropertiesAsync()) $propsType
      if ($props.Title -eq $hint -or $props.Artist -eq $hint) {
        $target = $s
        break
      }
    } catch {}
  }
}
if (-not $target) {
  Write-Output '{"sessionFound":false,"sourceAppUserModelId":null,"canPlayPause":false,"canNext":false,"canPrevious":false,"ok":false}'
  exit 0
}
$info = $target.GetPlaybackInfo()
$ctrl = $info.Controls
$canPP = [bool]($ctrl.IsPlayPauseToggleEnabled -or $ctrl.IsPlayEnabled -or $ctrl.IsPauseEnabled)
$canNext = [bool]$ctrl.IsNextEnabled
$canPrev = [bool]$ctrl.IsPreviousEnabled
$action = '${action}'
$ok = $true
if ($action -ne 'probe') {
  if ($action -eq 'toggle') { $ok = [bool](Await-WinRt ($target.TryTogglePlayPauseAsync()) ([bool])) }
  elseif ($action -eq 'play') { $ok = [bool](Await-WinRt ($target.TryPlayAsync()) ([bool])) }
  elseif ($action -eq 'pause') { $ok = [bool](Await-WinRt ($target.TryPauseAsync()) ([bool])) }
  elseif ($action -eq 'next') { $ok = [bool](Await-WinRt ($target.TrySkipNextAsync()) ([bool])) }
  elseif ($action -eq 'previous') { $ok = [bool](Await-WinRt ($target.TrySkipPreviousAsync()) ([bool])) }
}
$out = @{
  sessionFound = $true
  sourceAppUserModelId = [string]$target.SourceAppUserModelId
  canPlayPause = $canPP
  canNext = $canNext
  canPrevious = $canPrev
  ok = $ok
}
Write-Output ($out | ConvertTo-Json -Compress)
`.trim();
}

export class GsmtcController {
  private lastProbe: GsmtcProbeState = { ...DEFAULT_PROBE };
  private probing = false;

  get state(): GsmtcProbeState {
    return this.lastProbe;
  }

  /** Probe the Windows GSMTC session manager for an active VegaAM session. */
  async probe(matchHint?: string): Promise<GsmtcProbeState> {
    if (process.platform !== 'win32') {
      this.lastProbe = { ...DEFAULT_PROBE };
      return this.lastProbe;
    }
    if (this.probing) return this.lastProbe;
    this.probing = true;
    try {
      const result = await this.runHelper('probe', matchHint);
      this.lastProbe = {
        sessionFound: Boolean(result.sessionFound),
        sourceAppUserModelId: result.sourceAppUserModelId ?? null,
        canPlayPause: Boolean(result.canPlayPause),
        canNext: Boolean(result.canNext),
        canPrevious: Boolean(result.canPrevious),
      };
      return this.lastProbe;
    } catch {
      this.lastProbe = { ...DEFAULT_PROBE };
      return this.lastProbe;
    } finally {
      this.probing = false;
    }
  }

  /** Invoke a GSMTC transport command when supported. */
  async invoke(
    command: 'play' | 'pause' | 'toggle' | 'next' | 'previous',
    matchHint?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (process.platform !== 'win32') {
      return {
        ok: false,
        detail: 'OS media transport is not available on this platform. Use the official SiriusXM player.',
      };
    }
    try {
      const result = await this.runHelper(command, matchHint);
      this.lastProbe = {
        sessionFound: Boolean(result.sessionFound),
        sourceAppUserModelId: result.sourceAppUserModelId ?? null,
        canPlayPause: Boolean(result.canPlayPause),
        canNext: Boolean(result.canNext),
        canPrevious: Boolean(result.canPrevious),
      };
      if (!result.sessionFound) {
        return {
          ok: false,
          detail: 'No active Windows media session for SiriusXM. Use the official SiriusXM player.',
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          detail: `Windows media session rejected "${command}". Use the official SiriusXM player.`,
        };
      }
      return { ok: true, detail: `Executed "${command}" via Windows GSMTC.` };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'Windows GSMTC command failed.',
      };
    }
  }

  private runHelper(
    action: 'probe' | 'play' | 'pause' | 'toggle' | 'next' | 'previous',
    matchHint?: string,
  ): Promise<GsmtcProbeState & { ok?: boolean }> {
    return new Promise((resolve) => {
      const script = buildPowerShellScript(action, matchHint);
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 3500, windowsHide: true },
        (error, stdout) => {
          if (error || !stdout) {
            resolve({ ...DEFAULT_PROBE, ok: false });
            return;
          }
          try {
            const lines = stdout
              .trim()
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            const lastLine = lines[lines.length - 1] ?? '{}';
            const parsed = JSON.parse(lastLine) as GsmtcProbeState & { ok?: boolean };
            resolve(parsed);
          } catch {
            resolve({ ...DEFAULT_PROBE, ok: false });
          }
        },
      );
    });
  }
}
