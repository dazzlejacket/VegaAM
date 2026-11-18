/**
 * MPRIS (Media Player Remote Interfacing Specification) service.
 *
 * The service exposes the desktop media controls of a Linux session to the
 * application. It owns the bus name `org.mpris.MediaPlayer2.vegaamdesktop`
 * and exports the object `/org/mpris/MediaPlayer2` with the two MPRIS
 * interfaces (`org.mpris.MediaPlayer2` and `org.mpris.MediaPlayer2.Player`)
 * plus the standard `org.freedesktop.DBus.Properties` and
 * `org.freedesktop.DBus.Introspectable` helpers.
 *
 * The module is a pure state machine: the application feeds it with the
 * current playback state and receives remote commands through a callback. It
 * neither knows nor cares about Electron.
 *
 * Reference: https://specifications.freedesktop.org/mpris-spec/latest/
 */

import { DbusClient, DbusError, variant } from './dbus';
import type { DbusMessage, DbusTransport, DBusVariant } from './dbus';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** The playback status reported to the desktop. */
export type MprisPlaybackStatus = 'Playing' | 'Paused' | 'Stopped';

/** Metadata of the currently playing track. */
export interface MprisTrackMetadata {
  /** Object path identifying the track, e.g. `/org/mpris/MediaPlayer2/track/3`. */
  trackId?: string;
  /** Duration of the track in microseconds. */
  lengthUs?: number;
  /** URL of the cover art. */
  artUrl?: string;
  /** Track title. */
  title?: string;
  /** List of artists. */
  artist?: string[];
  /** Album name. */
  album?: string;
  /** Stream URL. */
  url?: string;
}

/** Capabilities advertised through the `Can*` properties. */
export interface MprisCapabilities {
  canGoNext: boolean;
  canGoPrevious: boolean;
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
  canControl: boolean;
}

/** A command requested by the desktop environment. */
export type MprisCommand =
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'playPause' }
  | { readonly type: 'stop' }
  | { readonly type: 'next' }
  | { readonly type: 'previous' }
  | { readonly type: 'seek'; readonly value: number }
  | { readonly type: 'setPosition'; readonly value: number; readonly trackId: string }
  | { readonly type: 'openUri'; readonly uri: string }
  | { readonly type: 'setVolume'; readonly value: number }
  | { readonly type: 'quit' }
  | { readonly type: 'raise' };

/** Options accepted by {@link MprisService}. */
export interface MprisServiceOptions {
  /** Bus name to own. Defaults to `org.mpris.MediaPlayer2.vegaamdesktop`. */
  busName?: string;
  /** Object path to export. Defaults to `/org/mpris/MediaPlayer2`. */
  objectPath?: string;
  /** Value of the `Identity` property. */
  identity?: string;
  /** Value of the `DesktopEntry` property. */
  desktopEntry?: string;
  /** Value of the `SupportedUriSchemes` property. */
  supportedUriSchemes?: string[];
  /** Value of the `SupportedMimeTypes` property. */
  supportedMimeTypes?: string[];
  /** Pre-built transport - used by the tests to fake the bus. */
  transport?: DbusTransport;
  /** Bus address; defaults to `DBUS_SESSION_BUS_ADDRESS`. */
  address?: string;
  /** UID used for the SASL handshake. */
  uid?: number;
  /** Called for every command issued by the desktop environment. */
  onCommand?: (command: MprisCommand) => void;
  /** Optional structured logger. */
  logger?: MprisLogger;
}

/** Optional structured logger - the service stays silent when it is omitted. */
export interface MprisLogger {
  debug?(message: string, ...details: unknown[]): void;
  warn?(message: string, ...details: unknown[]): void;
  error?(message: string, ...details: unknown[]): void;
}

/** Runtime state of the service. */
export interface MprisStatus {
  /** True while the bus name is owned. */
  connected: boolean;
  /** The bus name the service tries to own. */
  busName: string;
  /** The last error, if any. */
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Default bus name of the MPRIS service. */
export const MPRIS_BUS_NAME = 'org.mpris.MediaPlayer2.vegaamdesktop';
/** Default object path of the MPRIS service. */
export const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
/** The root MPRIS interface. */
export const MPRIS_ROOT_INTERFACE = 'org.mpris.MediaPlayer2';
/** The player MPRIS interface. */
export const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
/** The standard D-Bus properties interface. */
export const DBUS_PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
/** The standard D-Bus introspection interface. */
export const DBUS_INTROSPECTABLE_INTERFACE = 'org.freedesktop.DBus.Introspectable';

const DEFAULT_IDENTITY = 'VegaAM';
const DEFAULT_DESKTOP_ENTRY = 'vegaam';
const DEFAULT_URI_SCHEMES = ['http', 'https'];
const DEFAULT_MIME_TYPES = ['audio/mpeg', 'audio/aac'];

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

interface MprisState {
  playbackStatus: MprisPlaybackStatus;
  metadata: MprisTrackMetadata;
  volume: number;
  positionUs: number;
  minimumRate: number;
  maximumRate: number;
  capabilities: MprisCapabilities;
}

const DEFAULT_CAPABILITIES: MprisCapabilities = {
  canGoNext: true,
  canGoPrevious: true,
  canPlay: true,
  canPause: true,
  canSeek: true,
  canControl: true,
};

/**
 * A MPRIS service that mirrors the playback state of the application to the
 * desktop environment and forwards remote commands back to it.
 */
export class MprisService {
  private readonly options: MprisServiceOptions;
  private readonly logger: MprisLogger;
  private readonly busName: string;
  private readonly objectPath: string;
  private client?: DbusClient;
  private connected = false;
  private error?: string;
  private trackCounter = 0;
  private state: MprisState = {
    playbackStatus: 'Stopped',
    metadata: {},
    volume: 1,
    positionUs: 0,
    minimumRate: 1,
    maximumRate: 1,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };

  constructor(options: MprisServiceOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? {};
    this.busName = options.busName ?? MPRIS_BUS_NAME;
    this.objectPath = options.objectPath ?? MPRIS_OBJECT_PATH;
  }

  /** Current state of the service. */
  get status(): MprisStatus {
    return { connected: this.connected, busName: this.busName, error: this.error };
  }

  /** The playback status currently reported to the desktop. */
  get playbackStatus(): MprisPlaybackStatus {
    return this.state.playbackStatus;
  }

  /** The metadata currently reported to the desktop. */
  get metadata(): MprisTrackMetadata {
    return { ...this.state.metadata };
  }

  /** The volume currently reported to the desktop (0.0 - 1.0). */
  get volume(): number {
    return this.state.volume;
  }

  /** The playback position in microseconds. */
  get positionUs(): number {
    return this.state.positionUs;
  }

  /**
   * Connect to the session bus, greet the daemon and own the bus name.
   *
   * The promise rejects when no bus is reachable or when the name could not
   * be acquired; the reason is also available through {@link status}.
   */
  async start(): Promise<void> {
    if (this.client) return;
    const client = new DbusClient({
      transport: this.options.transport,
      address: this.options.address,
      uid: this.options.uid,
      logger: this.logger,
    });
    client.onMethodCall((message) => {
      this.handleMethodCall(message);
    });
    client.onClose((closeError) => {
      this.connected = false;
      if (closeError) this.error = closeError.message;
    });

    try {
      await client.connect();
      // DBUS_NAME_FLAG_ALLOW_REPLACEMENT | DBUS_NAME_FLAG_REPLACE_EXISTING
      const reply = await client.call(
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'RequestName',
        'su',
        [this.busName, 3],
      );
      const result = reply[0];
      if (result !== 1 && result !== 4) {
        throw new DbusError(
          'org.freedesktop.DBus.Error.NameHasNoOwner',
          `Could not acquire the bus name ${this.busName} (RequestName returned ${String(result)}).`,
        );
      }
      this.client = client;
      this.connected = true;
      this.error = undefined;
    } catch (error) {
      this.connected = false;
      this.error = error instanceof Error ? error.message : String(error);
      client.close();
      throw error instanceof Error ? error : new Error(this.error);
    }
  }

  /** Release the bus name and close the connection. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    if (!client) return;
    try {
      // The name is released with the connection anyway, so a slow daemon must
      // not block the shutdown of the application.
      await client.call(
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'ReleaseName',
        's',
        [this.busName],
        1000,
      );
    } catch {
      // The daemon may already be gone - closing the socket is enough.
    }
    client.close();
  }

  /* ---------------------------------------------------------------- *
   * State API used by the application
   * ---------------------------------------------------------------- */

  /** Update the playback status; a `PropertiesChanged` signal is emitted on change. */
  setPlaybackStatus(status: MprisPlaybackStatus): void {
    if (this.state.playbackStatus === status) return;
    this.state.playbackStatus = status;
    this.emitPropertiesChanged(MPRIS_PLAYER_INTERFACE, new Map([['PlaybackStatus', variant('s', status)]]));
  }

  /** Update the track metadata; a `PropertiesChanged` signal is emitted on change. */
  setMetadata(metadata: MprisTrackMetadata): void {
    if (metadataEquals(this.state.metadata, metadata)) return;
    this.state.metadata = { ...metadata };
    this.trackCounter += 1;
    this.emitPropertiesChanged(MPRIS_PLAYER_INTERFACE, new Map([['Metadata', this.metadataVariant()]]));
  }

  /** Update the volume (0.0 - 1.0); a `PropertiesChanged` signal is emitted on change. */
  setVolume(volume: number): void {
    const clamped = clamp(volume, 0, 1);
    if (this.state.volume === clamped) return;
    this.state.volume = clamped;
    this.emitPropertiesChanged(MPRIS_PLAYER_INTERFACE, new Map([['Volume', variant('d', clamped)]]));
  }

  /** Update the playback position in microseconds; a signal is emitted on change. */
  setPosition(positionUs: number): void {
    const value = Math.max(0, Math.round(positionUs));
    if (this.state.positionUs === value) return;
    this.state.positionUs = value;
    this.emitPropertiesChanged(MPRIS_PLAYER_INTERFACE, new Map([['Position', variant('x', BigInt(value))]]));
  }

  /** Update the advertised capabilities of the player. */
  setCapabilities(capabilities: Partial<MprisCapabilities>): void {
    const next: MprisCapabilities = { ...this.state.capabilities, ...capabilities };
    const changed = new Map<string, DBusVariant>();
    for (const key of Object.keys(next) as (keyof MprisCapabilities)[]) {
      if (this.state.capabilities[key] !== next[key]) {
        changed.set(propertyNameForCapability(key), variant('b', next[key]));
      }
    }
    if (changed.size === 0) return;
    this.state.capabilities = next;
    this.emitPropertiesChanged(MPRIS_PLAYER_INTERFACE, changed);
  }

  /* ---------------------------------------------------------------- *
   * Properties
   * ---------------------------------------------------------------- */

  /** All properties of an interface as D-Bus variants. */
  getAllProperties(interfaceName: string): Map<string, DBusVariant> {
    const properties = new Map<string, DBusVariant>();
    switch (interfaceName) {
      case MPRIS_ROOT_INTERFACE:
        properties.set('CanQuit', variant('b', true));
        properties.set('CanRaise', variant('b', true));
        properties.set('HasTrackList', variant('b', false));
        properties.set('Identity', variant('s', this.options.identity ?? DEFAULT_IDENTITY));
        properties.set('DesktopEntry', variant('s', this.options.desktopEntry ?? DEFAULT_DESKTOP_ENTRY));
        properties.set('SupportedUriSchemes', variant('as', this.options.supportedUriSchemes ?? DEFAULT_URI_SCHEMES));
        properties.set('SupportedMimeTypes', variant('as', this.options.supportedMimeTypes ?? DEFAULT_MIME_TYPES));
        return properties;
      case MPRIS_PLAYER_INTERFACE:
        properties.set('PlaybackStatus', variant('s', this.state.playbackStatus));
        properties.set('Metadata', this.metadataVariant());
        properties.set('Volume', variant('d', this.state.volume));
        properties.set('Position', variant('x', BigInt(this.state.positionUs)));
        properties.set('MinimumRate', variant('d', this.state.minimumRate));
        properties.set('MaximumRate', variant('d', this.state.maximumRate));
        properties.set('CanGoNext', variant('b', this.state.capabilities.canGoNext));
        properties.set('CanGoPrevious', variant('b', this.state.capabilities.canGoPrevious));
        properties.set('CanPlay', variant('b', this.state.capabilities.canPlay));
        properties.set('CanPause', variant('b', this.state.capabilities.canPause));
        properties.set('CanSeek', variant('b', this.state.capabilities.canSeek));
        properties.set('CanControl', variant('b', this.state.capabilities.canControl));
        return properties;
      default:
        return properties;
    }
  }

  /** A single property as D-Bus variant. */
  getProperty(interfaceName: string, propertyName: string): DBusVariant | undefined {
    return this.getAllProperties(interfaceName).get(propertyName);
  }

  /** The introspection XML of the exported object. */
  get introspectionXml(): string {
    return [
      '<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"',
      ' "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">',
      `<node name="${this.objectPath}">`,
      `  <interface name="${MPRIS_ROOT_INTERFACE}">`,
      '    <method name="Raise"/>',
      '    <method name="Quit"/>',
      '    <property name="CanQuit" type="b" access="read"/>',
      '    <property name="CanRaise" type="b" access="read"/>',
      '    <property name="HasTrackList" type="b" access="read"/>',
      '    <property name="Identity" type="s" access="read"/>',
      '    <property name="DesktopEntry" type="s" access="read"/>',
      '    <property name="SupportedUriSchemes" type="as" access="read"/>',
      '    <property name="SupportedMimeTypes" type="as" access="read"/>',
      '  </interface>',
      `  <interface name="${MPRIS_PLAYER_INTERFACE}">`,
      '    <method name="Next"/>',
      '    <method name="Previous"/>',
      '    <method name="Pause"/>',
      '    <method name="PlayPause"/>',
      '    <method name="Stop"/>',
      '    <method name="Play"/>',
      '    <method name="Seek">',
      '      <arg name="Offset" type="x" direction="in"/>',
      '    </method>',
      '    <method name="SetPosition">',
      '      <arg name="TrackId" type="o" direction="in"/>',
      '      <arg name="Position" type="x" direction="in"/>',
      '    </method>',
      '    <method name="OpenUri">',
      '      <arg name="Uri" type="s" direction="in"/>',
      '    </method>',
      '    <method name="SetVolume">',
      '      <arg name="Volume" type="d" direction="in"/>',
      '    </method>',
      '    <method name="Raise"/>',
      '    <property name="PlaybackStatus" type="s" access="read"/>',
      '    <property name="Metadata" type="a{sv}" access="read"/>',
      '    <property name="Volume" type="d" access="readwrite"/>',
      '    <property name="Position" type="x" access="read"/>',
      '    <property name="MinimumRate" type="d" access="read"/>',
      '    <property name="MaximumRate" type="d" access="read"/>',
      '    <property name="CanGoNext" type="b" access="read"/>',
      '    <property name="CanGoPrevious" type="b" access="read"/>',
      '    <property name="CanPlay" type="b" access="read"/>',
      '    <property name="CanPause" type="b" access="read"/>',
      '    <property name="CanSeek" type="b" access="read"/>',
      '    <property name="CanControl" type="b" access="read"/>',
      '  </interface>',
      `  <interface name="${DBUS_PROPERTIES_INTERFACE}">`,
      '    <method name="Get">',
      '      <arg name="interface_name" type="s" direction="in"/>',
      '      <arg name="property_name" type="s" direction="in"/>',
      '      <arg name="value" type="v" direction="out"/>',
      '    </method>',
      '    <method name="GetAll">',
      '      <arg name="interface_name" type="s" direction="in"/>',
      '      <arg name="properties" type="a{sv}" direction="out"/>',
      '    </method>',
      '    <method name="Set">',
      '      <arg name="interface_name" type="s" direction="in"/>',
      '      <arg name="property_name" type="s" direction="in"/>',
      '      <arg name="value" type="v" direction="in"/>',
      '    </method>',
      '    <signal name="PropertiesChanged">',
      '      <arg name="interface_name" type="s"/>',
      '      <arg name="changed_properties" type="a{sv}"/>',
      '      <arg name="invalidated_properties" type="as"/>',
      '    </signal>',
      '  </interface>',
      `  <interface name="${DBUS_INTROSPECTABLE_INTERFACE}">`,
      '    <method name="Introspect">',
      '      <arg name="xml_data" type="s" direction="out"/>',
      '    </method>',
      '  </interface>',
      '</node>',
    ].join('\n');
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private metadataVariant(): DBusVariant {
    const metadata = this.state.metadata;
    const entries = new Map<string, DBusVariant>();
    entries.set(
      'mpris:trackid',
      variant('o', metadata.trackId ?? `/org/mpris/MediaPlayer2/track/${this.trackCounter}`),
    );
    if (metadata.lengthUs !== undefined) {
      entries.set('mpris:length', variant('x', BigInt(Math.max(0, Math.round(metadata.lengthUs)))));
    }
    if (metadata.artUrl !== undefined) entries.set('mpris:artUrl', variant('s', metadata.artUrl));
    if (metadata.title !== undefined) entries.set('xesam:title', variant('s', metadata.title));
    if (metadata.artist !== undefined) entries.set('xesam:artist', variant('as', metadata.artist));
    if (metadata.album !== undefined) entries.set('xesam:album', variant('s', metadata.album));
    if (metadata.url !== undefined) entries.set('xesam:url', variant('s', metadata.url));
    return variant('a{sv}', entries);
  }

  private emitPropertiesChanged(interfaceName: string, changed: Map<string, DBusVariant>): void {
    if (changed.size === 0) return;
    this.client?.sendSignal(
      this.objectPath,
      DBUS_PROPERTIES_INTERFACE,
      'PropertiesChanged',
      'sa{sv}as',
      [interfaceName, changed, []],
    );
  }

  private handleMethodCall(message: DbusMessage): void {
    const client = this.client;
    if (!client) return;
    const path = message.path ?? '';
    if (path !== this.objectPath) {
      client.replyError(message, 'org.freedesktop.DBus.Error.UnknownObject', `Unknown object "${path}".`);
      return;
    }
    const interfaceName = message.interface ?? '';
    const member = message.member ?? '';

    switch (interfaceName) {
      case DBUS_INTROSPECTABLE_INTERFACE:
        if (member === 'Introspect') {
          client.reply(message, 's', [this.introspectionXml]);
          return;
        }
        break;
      case DBUS_PROPERTIES_INTERFACE:
        this.handlePropertiesCall(message, interfaceName, member);
        return;
      case MPRIS_ROOT_INTERFACE:
        if (member === 'Raise') {
          client.reply(message);
          return;
        }
        if (member === 'Quit') {
          this.emitCommand({ type: 'quit' });
          client.reply(message);
          return;
        }
        break;
      case MPRIS_PLAYER_INTERFACE:
        if (this.handlePlayerCall(message, member)) return;
        break;
      default:
        break;
    }

    client.replyError(
      message,
      'org.freedesktop.DBus.Error.UnknownMethod',
      `Unknown method "${interfaceName}.${member}".`,
    );
  }

  private handlePropertiesCall(message: DbusMessage, interfaceName: string, member: string): void {
    const client = this.client;
    if (!client) return;
    const body = message.body ?? [];
    const target = typeof body[0] === 'string' ? body[0] : '';
    const propertyName = typeof body[1] === 'string' ? body[1] : '';

    if (member === 'Get') {
      const value = this.getProperty(target, propertyName);
      if (!value) {
        client.replyError(
          message,
          'org.freedesktop.DBus.Error.InvalidArgs',
          `No such property "${target}.${propertyName}".`,
        );
        return;
      }
      client.reply(message, 'v', [value]);
      return;
    }
    if (member === 'GetAll') {
      client.reply(message, 'a{sv}', [this.getAllProperties(target)]);
      return;
    }
    if (member === 'Set') {
      const value = body[2];
      this.setProperty(target, propertyName, value);
      client.reply(message);
      return;
    }

    client.replyError(
      message,
      'org.freedesktop.DBus.Error.UnknownMethod',
      `Unknown method "${DBUS_PROPERTIES_INTERFACE}.${member}".`,
    );
  }

  private setProperty(interfaceName: string, propertyName: string, value: unknown): void {
    if (interfaceName !== MPRIS_PLAYER_INTERFACE || propertyName !== 'Volume') {
      this.logger.warn?.('Ignoring a request to set an unsupported MPRIS property.', interfaceName, propertyName);
      return;
    }
    const numeric = variantNumber(value);
    if (numeric === undefined) {
      this.logger.warn?.('Ignoring a request to set Volume with a non numeric value.');
      return;
    }
    this.setVolume(numeric);
    this.emitCommand({ type: 'setVolume', value: this.state.volume });
  }

  private handlePlayerCall(message: DbusMessage, member: string): boolean {
    const client = this.client;
    if (!client) return true;
    const body = message.body ?? [];

    switch (member) {
      case 'Play':
        this.emitCommand({ type: 'play' });
        client.reply(message);
        return true;
      case 'Pause':
        this.emitCommand({ type: 'pause' });
        client.reply(message);
        return true;
      case 'PlayPause':
        this.emitCommand({ type: 'playPause' });
        client.reply(message);
        return true;
      case 'Stop':
        this.emitCommand({ type: 'stop' });
        client.reply(message);
        return true;
      case 'Next':
        this.emitCommand({ type: 'next' });
        client.reply(message);
        return true;
      case 'Previous':
        this.emitCommand({ type: 'previous' });
        client.reply(message);
        return true;
      case 'Raise':
        client.reply(message);
        return true;
      case 'Seek': {
        const offset = microsecondsOf(body[0]);
        this.emitCommand({ type: 'seek', value: offset });
        client.reply(message);
        return true;
      }
      case 'SetPosition': {
        const trackId = typeof body[0] === 'string' ? body[0] : '';
        const position = microsecondsOf(body[1]);
        this.emitCommand({ type: 'setPosition', value: position, trackId });
        client.reply(message);
        return true;
      }
      case 'OpenUri': {
        const uri = typeof body[0] === 'string' ? body[0] : '';
        this.emitCommand({ type: 'openUri', uri });
        client.reply(message);
        return true;
      }
      case 'SetVolume': {
        const numeric = variantNumber(body[0]);
        if (numeric !== undefined) {
          this.setVolume(numeric);
          this.emitCommand({ type: 'setVolume', value: this.state.volume });
        }
        client.reply(message);
        return true;
      }
      default:
        return false;
    }
  }

  private emitCommand(command: MprisCommand): void {
    try {
      this.options.onCommand?.(command);
    } catch (error) {
      this.logger.error?.('The MPRIS command handler threw an error.', error);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function microsecondsOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Math.round(value);
  return 0;
}

function variantNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner = (value as DBusVariant).value;
    if (typeof inner === 'number') return inner;
    if (typeof inner === 'bigint') return Number(inner);
  }
  return undefined;
}

function propertyNameForCapability(key: keyof MprisCapabilities): string {
  switch (key) {
    case 'canGoNext':
      return 'CanGoNext';
    case 'canGoPrevious':
      return 'CanGoPrevious';
    case 'canPlay':
      return 'CanPlay';
    case 'canPause':
      return 'CanPause';
    case 'canSeek':
      return 'CanSeek';
    case 'canControl':
      return 'CanControl';
  }
}

function metadataEquals(a: MprisTrackMetadata, b: MprisTrackMetadata): boolean {
  if (a.trackId !== b.trackId) return false;
  if (a.lengthUs !== b.lengthUs) return false;
  if (a.artUrl !== b.artUrl) return false;
  if (a.title !== b.title) return false;
  if (a.album !== b.album) return false;
  if (a.url !== b.url) return false;
  const artistsA = a.artist ?? [];
  const artistsB = b.artist ?? [];
  if (artistsA.length !== artistsB.length) return false;
  return artistsA.every((artist, index) => artist === artistsB[index]);
}
