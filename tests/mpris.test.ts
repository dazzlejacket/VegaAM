import { describe, expect, it } from 'vitest';

import {
  DbusClient,
  DbusError,
  decodeMessage,
  encodeMessage,
  marshalBody,
  parseBusAddress,
  parseMessages,
  splitSignature,
  unmarshalBody,
  variant,
} from '../src/core/mpris/dbus';
import type { DBusVariant, DbusMessage, DbusTransport, DbusTransportEvent, DbusTransportPayload } from '../src/core/mpris/dbus';
import { MprisService } from '../src/core/mpris/mpris';
import type { MprisCommand } from '../src/core/mpris/mpris';

const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_INTERFACE = 'org.mpris.MediaPlayer2';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const INTROSPECTABLE_INTERFACE = 'org.freedesktop.DBus.Introspectable';

/**
 * In-memory fake of a D-Bus session bus.
 *
 * It performs the SASL handshake, answers `Hello` / `RequestName` and records
 * every message the client sends so the tests can assert on the wire format.
 */
class FakeBusTransport implements DbusTransport {
  /** Raw chunks the client wrote. */
  readonly written: Buffer[] = [];
  /** Decoded messages the client sent. */
  readonly messages: DbusMessage[] = [];
  /** Authentication lines the client sent. */
  readonly authLines: string[] = [];

  private readonly handlers = new Map<DbusTransportEvent, ((payload: DbusTransportPayload) => void)[]>();
  private authText = '';
  private binary = false;
  private buffer: Buffer = Buffer.alloc(0);

  write(chunk: Buffer): void {
    this.written.push(Buffer.from(chunk));
    if (!this.binary) {
      this.handleAuth(chunk);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, rest } = parseMessages(this.buffer);
    this.buffer = rest;
    for (const message of messages) {
      this.messages.push(message);
      this.handleOutgoing(message);
    }
  }

  on(event: DbusTransportEvent, handler: (payload: DbusTransportPayload) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  end(): void {
    /* The fake bus never really closes. */
  }

  /** Deliver an incoming message to the client. */
  deliver(message: DbusMessage): void {
    const chunk = encodeMessage(message);
    for (const handler of this.handlers.get('data') ?? []) handler(chunk);
  }

  /** Every method call the client sent. */
  calls(): DbusMessage[] {
    return this.messages.filter((message) => message.type === 'method_call');
  }

  /** Every reply the client sent. */
  replies(): DbusMessage[] {
    return this.messages.filter((message) => message.type === 'method_return');
  }

  /** Every signal the client emitted. */
  signals(): DbusMessage[] {
    return this.messages.filter((message) => message.type === 'signal');
  }

  /** The reply the client sent for the given incoming serial. */
  replyFor(serial: number): DbusMessage | undefined {
    return this.replies().find((message) => message.replySerial === serial);
  }

  private handleAuth(chunk: Buffer): void {
    this.authText += chunk.toString('latin1');
    for (;;) {
      const index = this.authText.indexOf('\r\n');
      if (index < 0) break;
      const line = this.authText.slice(0, index).replace(/\0/g, '');
      this.authText = this.authText.slice(index + 2);
      this.authLines.push(line);
      if (line.startsWith('AUTH ')) {
        this.push(Buffer.from('OK 0123456789abcdef0123456789abcdef\r\n', 'ascii'));
      } else if (line === 'NEGOTIATE_UNIX_FD') {
        this.push(Buffer.from('AGREE_UNIX_FD\r\n', 'ascii'));
      } else if (line === 'BEGIN') {
        this.binary = true;
      }
    }
  }

  private push(data: Buffer): void {
    for (const handler of this.handlers.get('data') ?? []) handler(data);
  }

  private handleOutgoing(message: DbusMessage): void {
    const reply = (signature: string, body: unknown[]): void => {
      this.deliver({
        type: 'method_return',
        replySerial: message.serial,
        destination: message.sender,
        signature,
        body,
      });
    };
    switch (message.member) {
      case 'Hello':
        reply('s', [':1.42']);
        return;
      case 'RequestName':
      case 'ReleaseName':
        reply('u', [1]);
        return;
      case 'ListNames':
        reply('as', [[':1.42', ':1.43']]);
        return;
      case 'GetNameOwner':
        this.deliver({
          type: 'error',
          replySerial: message.serial,
          destination: message.sender,
          errorName: 'org.freedesktop.DBus.Error.NameHasNoOwner',
          signature: 's',
          body: ['No such name'],
        });
        return;
      default:
        return;
    }
  }
}

interface Harness {
  service: MprisService;
  bus: FakeBusTransport;
  commands: MprisCommand[];
}

async function startService(): Promise<Harness> {
  const bus = new FakeBusTransport();
  const commands: MprisCommand[] = [];
  const service = new MprisService({
    transport: bus,
    onCommand: (command) => {
      commands.push(command);
    },
  });
  await service.start();
  return { service, bus, commands };
}

function deliverCall(
  bus: FakeBusTransport,
  serial: number,
  interfaceName: string,
  member: string,
  signature = '',
  body: unknown[] = [],
): number {
  bus.deliver({
    type: 'method_call',
    serial,
    path: OBJECT_PATH,
    interface: interfaceName,
    member,
    signature,
    body,
  });
  return serial;
}

describe('D-Bus marshalling', () => {
  it('splits signatures into complete types', () => {
    expect(splitSignature('a{sv}')).toEqual(['a{sv}']);
    expect(splitSignature('a(ssus)')).toEqual(['a(ssus)']);
    expect(splitSignature('sa{sv}as')).toEqual(['s', 'a{sv}', 'as']);
    expect(splitSignature('(bsx)')).toEqual(['(bsx)']);
    expect(splitSignature('a{sa{sv}}')).toEqual(['a{sa{sv}}']);
    expect(splitSignature('a(oa{sv})')).toEqual(['a(oa{sv})']);
  });

  it('round-trips the basic types', () => {
    const values: unknown[] = [
      200,
      true,
      -1234,
      4321,
      -70000,
      70000,
      -9007199254740993n,
      9007199254740993n,
      0.75,
      'hello',
      '/org/mpris/MediaPlayer2',
      'a{sv}',
    ];
    const encoded = marshalBody('ybnqiuxtdsog', values);
    expect(unmarshalBody('ybnqiuxtdsog', encoded)).toEqual(values);
  });

  it('round-trips variants of different signatures', () => {
    const values: unknown[] = [variant('s', 'text'), variant('u', 7), variant('as', ['a', 'b'])];
    const encoded = marshalBody('vvv', values);
    expect(unmarshalBody('vvv', encoded)).toEqual(values);
  });

  it('round-trips a{sv} dictionaries', () => {
    const entries = new Map<string, DBusVariant>([
      ['mpris:trackid', variant('o', '/org/mpris/MediaPlayer2/track/1')],
      ['mpris:length', variant('x', 123456n)],
      ['xesam:artist', variant('as', ['Artist'])],
    ]);
    const decoded = unmarshalBody('a{sv}', marshalBody('a{sv}', [entries]))[0] as Map<string, DBusVariant>;
    expect(decoded.get('mpris:trackid')).toEqual(variant('o', '/org/mpris/MediaPlayer2/track/1'));
    expect(decoded.get('mpris:length')).toEqual(variant('x', 123456n));
    expect(decoded.get('xesam:artist')).toEqual(variant('as', ['Artist']));
  });

  it('round-trips a(ssus) arrays', () => {
    const values = [
      ['alpha', 'beta', 3, 'gamma'],
      ['delta', 'epsilon', 6, 'zeta'],
    ];
    expect(unmarshalBody('a(ssus)', marshalBody('a(ssus)', [values]))).toEqual([values]);
  });

  it('round-trips a(oa{sv}) metadata arrays', () => {
    const entries = new Map<string, DBusVariant>([['xesam:title', variant('s', 'Song')]]);
    const values = [['/org/mpris/MediaPlayer2/track/1', entries]];
    const decoded = unmarshalBody('a(oa{sv})', marshalBody('a(oa{sv})', [values]))[0] as [
      string,
      Map<string, DBusVariant>,
    ][];
    expect(decoded[0]?.[0]).toBe('/org/mpris/MediaPlayer2/track/1');
    expect(decoded[0]?.[1].get('xesam:title')).toEqual(variant('s', 'Song'));
  });

  it('round-trips the remaining container types', () => {
    expect(unmarshalBody('as', marshalBody('as', [['a', 'b']]))).toEqual([['a', 'b']]);
    expect(unmarshalBody('ao', marshalBody('ao', [['/a', '/b']]))).toEqual([['/a', '/b']]);

    const playback = new Map<string, [boolean, DBusVariant]>([['state', [true, variant('s', 'Playing')]]]);
    const decodedPlayback = unmarshalBody(
      'a{s(bv)}',
      marshalBody('a{s(bv)}', [playback]),
    )[0] as Map<string, [boolean, DBusVariant]>;
    expect(decodedPlayback.get('state')).toEqual([true, variant('s', 'Playing')]);

    const properties = new Map<string, DBusVariant>([['Volume', variant('d', 0.5)]]);
    const decodedProperties = unmarshalBody(
      'a{sa{sv}}',
      marshalBody('a{sa{sv}}', [new Map([[PLAYER_INTERFACE, properties]])]),
    )[0] as Map<string, Map<string, DBusVariant>>;
    expect(decodedProperties.get(PLAYER_INTERFACE)?.get('Volume')).toEqual(variant('d', 0.5));
  });

  it('round-trips struct arguments', () => {
    expect(unmarshalBody('(bs)', marshalBody('(bs)', [[true, 'seek']]))).toEqual([[true, 'seek']]);
    expect(unmarshalBody('(bsx)', marshalBody('(bsx)', [[false, 'seek', 42n]]))).toEqual([[false, 'seek', 42n]]);
  });

  it('round-trips a full message header', () => {
    const message: DbusMessage = {
      type: 'method_call',
      serial: 42,
      path: OBJECT_PATH,
      interface: PLAYER_INTERFACE,
      member: 'Seek',
      destination: 'org.mpris.MediaPlayer2.vegaamdesktop',
      sender: ':1.7',
      signature: 'x',
      body: [123456n],
    };
    const encoded = encodeMessage(message);
    const decoded = decodeMessage(encoded);

    expect(encoded.readUInt8(0)).toBe(0x6c); // little endian
    expect(encoded.readUInt8(1)).toBe(1); // method call
    expect(encoded.readUInt8(3)).toBe(1); // protocol version
    expect(encoded.readUInt32LE(4)).toBe(8); // body length
    expect(encoded.readUInt32LE(8)).toBe(42); // serial
    expect(decoded?.length).toBe(encoded.length);
    expect(decoded?.message.type).toBe('method_call');
    expect(decoded?.message.serial).toBe(42);
    expect(decoded?.message.path).toBe(OBJECT_PATH);
    expect(decoded?.message.interface).toBe(PLAYER_INTERFACE);
    expect(decoded?.message.member).toBe('Seek');
    expect(decoded?.message.destination).toBe('org.mpris.MediaPlayer2.vegaamdesktop');
    expect(decoded?.message.sender).toBe(':1.7');
    expect(decoded?.message.signature).toBe('x');
    expect(decoded?.message.body).toEqual([123456n]);
  });

  it('reports incomplete messages instead of guessing', () => {
    const encoded = encodeMessage({ type: 'signal', serial: 1, path: OBJECT_PATH, member: 'X' });
    expect(decodeMessage(encoded.subarray(0, 10))).toBeUndefined();
    const { messages, rest } = parseMessages(Buffer.concat([encoded, encoded]));
    expect(messages).toHaveLength(2);
    expect(rest.length).toBe(0);
  });

  it('parses unix bus addresses', () => {
    expect(parseBusAddress('unix:path=/run/user/1000/bus')).toEqual({ transport: 'unix', path: '/run/user/1000/bus' });
    expect(parseBusAddress('unix:abstract=/tmp/dbus-abc,guid=1234')).toEqual({
      transport: 'unix',
      abstract: '/tmp/dbus-abc',
    });
    expect(() => parseBusAddress('tcp:host=localhost,port=1234')).toThrow(DbusError);
  });
});

describe('D-Bus client', () => {
  it('performs the SASL handshake and sends a framed Hello', async () => {
    const bus = new FakeBusTransport();
    const client = new DbusClient({ transport: bus, uid: 1000 });

    await client.connect();

    expect(bus.authLines[0]).toMatch(/^AUTH EXTERNAL [0-9a-f]+$/);
    expect(bus.authLines[0]).toContain('AUTH EXTERNAL 31303030'); // hex of the decimal uid "1000"
    expect(bus.authLines).toContain('NEGOTIATE_UNIX_FD');
    expect(bus.authLines[bus.authLines.length - 1]).toBe('BEGIN');

    const hello = bus.calls().find((message) => message.member === 'Hello');
    expect(hello).toBeDefined();
    expect(hello?.type).toBe('method_call');
    expect(hello?.destination).toBe('org.freedesktop.DBus');
    expect(hello?.path).toBe('/org/freedesktop/DBus');
    expect(hello?.interface).toBe('org.freedesktop.DBus');
    expect(hello?.serial).toBe(1);
    expect(client.uniqueName).toBe(':1.42');
  });

  it('parses a framed reply', async () => {
    const bus = new FakeBusTransport();
    const client = new DbusClient({ transport: bus });
    await client.connect();

    const names = await client.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames');
    expect(names).toEqual([[':1.42', ':1.43']]);
  });

  it('surfaces remote errors with their D-Bus error name', async () => {
    const bus = new FakeBusTransport();
    const client = new DbusClient({ transport: bus });
    await client.connect();

    await expect(
      client.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', ['nope']),
    ).rejects.toThrow(/org\.freedesktop\.DBus\.Error\.NameHasNoOwner/);
  });
});

describe('MPRIS service', () => {
  it('acquires the bus name with a correctly framed RequestName', async () => {
    const { bus, service } = await startService();

    const request = bus.calls().find((message) => message.member === 'RequestName');
    expect(request?.destination).toBe('org.freedesktop.DBus');
    expect(request?.path).toBe('/org/freedesktop/DBus');
    expect(request?.interface).toBe('org.freedesktop.DBus');
    expect(request?.signature).toBe('su');
    expect(request?.body?.[0]).toBe('org.mpris.MediaPlayer2.vegaamdesktop');
    expect(request?.body?.[1]).toBe(3); // ALLOW_REPLACEMENT | REPLACE_EXISTING
    expect(service.status.connected).toBe(true);
    expect(service.status.busName).toBe('org.mpris.MediaPlayer2.vegaamdesktop');
  });

  it('answers GetAll with the player properties', async () => {
    const { bus } = await startService();

    deliverCall(bus, 10, PROPERTIES_INTERFACE, 'GetAll', 's', [PLAYER_INTERFACE]);
    const reply = bus.replyFor(10);

    expect(reply?.signature).toBe('a{sv}');
    const properties = reply?.body?.[0] as Map<string, DBusVariant>;
    expect(properties.get('PlaybackStatus')).toEqual(variant('s', 'Stopped'));
    expect(properties.get('Volume')).toEqual(variant('d', 1));
    expect(properties.get('Position')).toEqual(variant('x', 0n));
    expect(properties.get('MinimumRate')).toEqual(variant('d', 1));
    expect(properties.get('MaximumRate')).toEqual(variant('d', 1));
    expect(properties.get('CanGoNext')).toEqual(variant('b', true));
    expect(properties.get('CanGoPrevious')).toEqual(variant('b', true));
    expect(properties.get('CanPlay')).toEqual(variant('b', true));
    expect(properties.get('CanPause')).toEqual(variant('b', true));
    expect(properties.get('CanSeek')).toEqual(variant('b', true));
    expect(properties.get('CanControl')).toEqual(variant('b', true));
    expect(properties.get('Metadata')).toBeDefined();
  });

  it('answers Get with the current playback status', async () => {
    const { bus, service } = await startService();
    service.setPlaybackStatus('Playing');

    deliverCall(bus, 11, PROPERTIES_INTERFACE, 'Get', 'ss', [PLAYER_INTERFACE, 'PlaybackStatus']);
    const reply = bus.replyFor(11);

    expect(reply?.signature).toBe('v');
    expect(reply?.body?.[0]).toEqual(variant('s', 'Playing'));
  });

  it('routes a Set of Volume through the application callback', async () => {
    const { bus, service, commands } = await startService();

    deliverCall(bus, 12, PROPERTIES_INTERFACE, 'Set', 'ssv', [
      PLAYER_INTERFACE,
      'Volume',
      variant('d', 0.25),
    ]);

    expect(commands).toEqual([{ type: 'setVolume', value: 0.25 }]);
    expect(service.volume).toBe(0.25);
    expect(bus.replyFor(12)).toBeDefined();
  });

  it('dispatches an incoming Play call to the application callback', async () => {
    const { bus, commands } = await startService();

    deliverCall(bus, 13, PLAYER_INTERFACE, 'Play');

    expect(commands).toEqual([{ type: 'play' }]);
    expect(bus.replyFor(13)?.type).toBe('method_return');
  });

  it('dispatches seeking and track changes to the application callback', async () => {
    const { bus, commands } = await startService();

    deliverCall(bus, 14, PLAYER_INTERFACE, 'Seek', 'x', [5000000n]);
    deliverCall(bus, 15, PLAYER_INTERFACE, 'SetPosition', 'ox', ['/org/mpris/MediaPlayer2/track/3', 1234n]);
    deliverCall(bus, 16, PLAYER_INTERFACE, 'Next');

    expect(commands).toEqual([
      { type: 'seek', value: 5000000 },
      { type: 'setPosition', value: 1234, trackId: '/org/mpris/MediaPlayer2/track/3' },
      { type: 'next' },
    ]);
  });

  it('returns an introspection XML that lists both MPRIS interfaces', async () => {
    const { bus } = await startService();

    deliverCall(bus, 17, INTROSPECTABLE_INTERFACE, 'Introspect');
    const xml = String(bus.replyFor(17)?.body?.[0] ?? '');

    expect(xml).toContain(PLAYER_INTERFACE);
    expect(xml).toContain(ROOT_INTERFACE);
    expect(xml).toContain('PropertiesChanged');
    expect(xml).toContain('<property name="PlaybackStatus" type="s" access="read"/>');
  });

  it('emits exactly one PropertiesChanged signal when the status changes', async () => {
    const { bus, service } = await startService();
    const before = bus.signals().length;

    service.setPlaybackStatus('Playing');

    expect(bus.signals().length).toBe(before + 1);
    const signal = bus.signals()[bus.signals().length - 1];
    expect(signal?.type).toBe('signal');
    expect(signal?.interface).toBe(PROPERTIES_INTERFACE);
    expect(signal?.member).toBe('PropertiesChanged');
    expect(signal?.path).toBe(OBJECT_PATH);
    expect(signal?.signature).toBe('sa{sv}as');
    const changed = signal?.body?.[1] as Map<string, DBusVariant>;
    expect(changed.get('PlaybackStatus')).toEqual(variant('s', 'Playing'));
    expect(signal?.body?.[0]).toBe(PLAYER_INTERFACE);

    // Setting the same value again must not emit another signal.
    service.setPlaybackStatus('Playing');
    expect(bus.signals().length).toBe(before + 1);
  });

  it('publishes the track metadata as a{sv}', async () => {
    const { bus, service } = await startService();

    service.setMetadata({
      trackId: '/org/mpris/MediaPlayer2/track/7',
      lengthUs: 180_000_000,
      title: 'Song',
      artist: ['Artist'],
      album: 'Album',
      url: 'https://example.com/stream',
    });

    deliverCall(bus, 18, PROPERTIES_INTERFACE, 'Get', 'ss', [PLAYER_INTERFACE, 'Metadata']);
    const metadata = bus.replyFor(18)?.body?.[0] as DBusVariant;
    const entries = metadata.value as Map<string, DBusVariant>;

    expect(metadata.signature).toBe('a{sv}');
    expect(entries.get('mpris:trackid')).toEqual(variant('o', '/org/mpris/MediaPlayer2/track/7'));
    expect(entries.get('mpris:length')).toEqual(variant('x', 180_000_000n));
    expect(entries.get('xesam:title')).toEqual(variant('s', 'Song'));
    expect(entries.get('xesam:artist')).toEqual(variant('as', ['Artist']));
    expect(entries.get('xesam:album')).toEqual(variant('s', 'Album'));
    expect(entries.get('xesam:url')).toEqual(variant('s', 'https://example.com/stream'));
  });

  it('releases the bus name when the service is stopped', async () => {
    const { bus, service } = await startService();

    await service.stop();

    const release = bus.calls().find((message) => message.member === 'ReleaseName');
    expect(release?.body?.[0]).toBe('org.mpris.MediaPlayer2.vegaamdesktop');
    expect(service.status.connected).toBe(false);
  });

  it('reports an error for unknown methods', async () => {
    const { bus } = await startService();

    deliverCall(bus, 19, PLAYER_INTERFACE, 'Explode');

    const error = bus.messages.find((message) => message.type === 'error' && message.replySerial === 19);
    expect(error?.errorName).toBe('org.freedesktop.DBus.Error.UnknownMethod');
  });
});
