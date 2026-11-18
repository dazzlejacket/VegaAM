/**
 * Minimal, dependency-free D-Bus client.
 *
 * The module implements just enough of the D-Bus wire protocol to talk to a
 * session bus from a plain Node.js process:
 *
 *   - SASL EXTERNAL authentication over the socket,
 *   - the little-endian message format (fixed header + `a(yv)` header fields),
 *   - marshalling and unmarshalling for the type subset used by MPRIS.
 *
 * No native module and no npm dependency is required - only `node:net` for
 * the transport. The transport itself is injectable (`DbusTransport`) so the
 * whole stack can be exercised against an in-memory fake bus in the tests
 * without a running daemon.
 *
 * Reference: https://dbus.freedesktop.org/doc/dbus-specification.html
 */

import net from 'node:net';
import os from 'node:os';

/* ------------------------------------------------------------------ *
 * Errors and logging
 * ------------------------------------------------------------------ */

/** Error raised for protocol, transport and remote-error failures. */
export class DbusError extends Error {
  /** The D-Bus error name, e.g. `org.freedesktop.DBus.Error.NoReply`. */
  readonly errorName: string;

  constructor(errorName: string, detail?: string) {
    super(detail ? `${errorName}: ${detail}` : errorName);
    this.name = 'DbusError';
    this.errorName = errorName;
  }
}

/** Optional structured logger - the client stays silent when it is omitted. */
export interface DbusLogger {
  debug?(message: string, ...details: unknown[]): void;
  warn?(message: string, ...details: unknown[]): void;
  error?(message: string, ...details: unknown[]): void;
}

const NOOP_LOGGER: DbusLogger = {};

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/** Events emitted by a transport. */
export type DbusTransportEvent = 'data' | 'close' | 'error';

/**
 * Payload delivered for a transport event: a chunk for `data`, an `Error`
 * for `error` and `undefined` for `close`.
 */
export type DbusTransportPayload = Buffer | Error | undefined;

/**
 * A byte oriented, injectable connection to a D-Bus daemon.
 *
 * The interface is intentionally tiny so that a test can implement it with a
 * few lines of code.
 */
export interface DbusTransport {
  /** Write raw bytes towards the bus. */
  write(chunk: Buffer): void;
  /** Subscribe to a transport event. */
  on(event: DbusTransportEvent, handler: (payload: DbusTransportPayload) => void): void;
  /** Close the transport. */
  end(): void;
}

/** Adapter that exposes a `net.Socket` as a {@link DbusTransport}. */
export class SocketTransport implements DbusTransport {
  constructor(private readonly socket: net.Socket) {}

  write(chunk: Buffer): void {
    this.socket.write(chunk);
  }

  on(event: DbusTransportEvent, handler: (payload: DbusTransportPayload) => void): void {
    if (event === 'data') {
      this.socket.on('data', (chunk: Buffer) => {
        handler(chunk);
      });
      return;
    }
    if (event === 'close') {
      this.socket.on('close', () => {
        handler(undefined);
      });
      return;
    }
    this.socket.on('error', (error: Error) => {
      handler(error);
    });
  }

  end(): void {
    this.socket.end();
  }
}

/* ------------------------------------------------------------------ *
 * Bus address
 * ------------------------------------------------------------------ */

/** A parsed `DBUS_SESSION_BUS_ADDRESS` entry. */
export interface DbusAddress {
  /** Only the unix transport is supported. */
  readonly transport: 'unix';
  /** Filesystem path of the socket. */
  readonly path?: string;
  /** Abstract (namespaced) socket name. */
  readonly abstract?: string;
}

/**
 * Parse the first usable unix entry of a `DBUS_SESSION_BUS_ADDRESS` value.
 *
 * Addresses look like `unix:path=/run/user/1000/bus` or
 * `unix:abstract=/tmp/dbus-XXXX` and may be a `;` separated list.
 */
export function parseBusAddress(address: string): DbusAddress {
  for (const entry of address.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const transport = trimmed.slice(0, separator);
    if (transport !== 'unix') continue;

    const params = new Map<string, string>();
    for (const part of trimmed.slice(separator + 1).split(',')) {
      const equals = part.indexOf('=');
      if (equals <= 0) continue;
      params.set(part.slice(0, equals), part.slice(equals + 1));
    }

    const path = params.get('path');
    if (path) return { transport: 'unix', path };
    const abstract = params.get('abstract');
    if (abstract) return { transport: 'unix', abstract };
  }
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `No usable unix transport in D-Bus address: ${address}`,
  );
}

/* ------------------------------------------------------------------ *
 * Type system
 * ------------------------------------------------------------------ */

/** A value together with the D-Bus signature it is marshalled with. */
export interface DBusVariant {
  /** The complete signature of the contained value, e.g. `s` or `a{sv}`. */
  readonly signature: string;
  /** The contained value. */
  readonly value: unknown;
}

/** Wrap a value into a D-Bus variant. */
export function variant(signature: string, value: unknown): DBusVariant {
  return { signature, value };
}

/** Basic D-Bus type codes. */
export type DbusTypeCode = 'y' | 'b' | 'n' | 'q' | 'i' | 'u' | 'x' | 't' | 'd' | 'h' | 's' | 'o' | 'g';

/** Parsed representation of a D-Bus type. */
export type DbusTypeNode =
  | { readonly kind: 'basic'; readonly code: DbusTypeCode }
  | { readonly kind: 'array'; readonly element: DbusTypeNode }
  | { readonly kind: 'struct'; readonly members: readonly DbusTypeNode[] }
  | { readonly kind: 'dict'; readonly key: DbusTypeNode; readonly value: DbusTypeNode }
  | { readonly kind: 'variant' };

const BASIC_ALIGNMENT: Record<DbusTypeCode, number> = {
  y: 1,
  b: 4,
  n: 2,
  q: 2,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  h: 4,
  s: 4,
  o: 4,
  g: 1,
};

const BASIC_CODES: readonly string[] = Object.keys(BASIC_ALIGNMENT);

/** Parse a single complete type starting at `position`. */
function parseType(signature: string, position: number): { type: DbusTypeNode; next: number } {
  const code = signature[position];
  if (code === undefined) {
    throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', 'Unexpected end of D-Bus signature.');
  }
  if (code === 'a') {
    const inner = parseType(signature, position + 1);
    return { type: { kind: 'array', element: inner.type }, next: inner.next };
  }
  if (code === '(') {
    const members: DbusTypeNode[] = [];
    let cursor = position + 1;
    while (signature[cursor] !== ')') {
      if (cursor >= signature.length) {
        throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', 'Unterminated struct in D-Bus signature.');
      }
      const member = parseType(signature, cursor);
      members.push(member.type);
      cursor = member.next;
    }
    return { type: { kind: 'struct', members }, next: cursor + 1 };
  }
  if (code === '{') {
    const key = parseType(signature, position + 1);
    const value = parseType(signature, key.next);
    if (signature[value.next] !== '}') {
      throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', 'Unterminated dict entry in D-Bus signature.');
    }
    return { type: { kind: 'dict', key: key.type, value: value.type }, next: value.next + 1 };
  }
  if (code === 'v') {
    return { type: { kind: 'variant' }, next: position + 1 };
  }
  if (!BASIC_CODES.includes(code)) {
    throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', `Unsupported D-Bus type code "${code}".`);
  }
  return { type: { kind: 'basic', code: code as DbusTypeCode }, next: position + 1 };
}

/** Split a signature into its complete types, e.g. `a{sv}` into `["a{sv}"]`. */
export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  let cursor = 0;
  while (cursor < signature.length) {
    const parsed = parseType(signature, cursor);
    types.push(signature.slice(cursor, parsed.next));
    cursor = parsed.next;
  }
  return types;
}

/** Alignment (in bytes) of a type. */
export function alignmentOf(type: DbusTypeNode): number {
  switch (type.kind) {
    case 'basic':
      return BASIC_ALIGNMENT[type.code];
    case 'array':
      return 4;
    case 'struct':
      return 8;
    case 'dict':
      return 8;
    case 'variant':
      return 1;
  }
}

/* ------------------------------------------------------------------ *
 * Byte reader / writer
 * ------------------------------------------------------------------ */

/** Little/big endian aware writer used by the marshaller. */
class ByteWriter {
  private buffer: Buffer;
  private offset = 0;

  constructor(size = 256) {
    this.buffer = Buffer.allocUnsafe(Math.max(size, 16));
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.offset + extra) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buffer.copy(next, 0, 0, this.offset);
    this.buffer = next;
  }

  /** Pad with zeroes until the offset is a multiple of `alignment`. */
  align(alignment: number): void {
    const remainder = this.offset % alignment;
    if (remainder === 0) return;
    const padding = alignment - remainder;
    this.ensure(padding);
    this.buffer.fill(0, this.offset, this.offset + padding);
    this.offset += padding;
  }

  writeUInt8(value: number): void {
    this.ensure(1);
    this.buffer.writeUInt8(value & 0xff, this.offset);
    this.offset += 1;
  }

  writeUInt16LE(value: number): void {
    this.ensure(2);
    this.buffer.writeUInt16LE(value & 0xffff, this.offset);
    this.offset += 2;
  }

  writeUInt32LE(value: number): void {
    this.ensure(4);
    this.buffer.writeUInt32LE(value >>> 0, this.offset);
    this.offset += 4;
  }

  writeInt16LE(value: number): void {
    this.ensure(2);
    this.buffer.writeInt16LE(value | 0, this.offset);
    this.offset += 2;
  }

  writeInt32LE(value: number): void {
    this.ensure(4);
    this.buffer.writeInt32LE(value | 0, this.offset);
    this.offset += 4;
  }

  writeInt64LE(value: bigint): void {
    this.ensure(8);
    this.buffer.writeBigInt64LE(value, this.offset);
    this.offset += 8;
  }

  writeUInt64LE(value: bigint): void {
    this.ensure(8);
    this.buffer.writeBigUInt64LE(value, this.offset);
    this.offset += 8;
  }

  writeDoubleLE(value: number): void {
    this.ensure(8);
    this.buffer.writeDoubleLE(value, this.offset);
    this.offset += 8;
  }

  writeBytes(data: Buffer): void {
    this.ensure(data.length);
    data.copy(this.buffer, this.offset);
    this.offset += data.length;
  }

  toBuffer(): Buffer {
    return this.buffer.subarray(0, this.offset);
  }
}

/** Little/big endian aware reader used by the unmarshaller. */
class ByteReader {
  offset: number;

  constructor(
    private readonly buffer: Buffer,
    offset = 0,
    private readonly little = true,
  ) {
    this.offset = offset;
  }

  align(alignment: number): void {
    const remainder = this.offset % alignment;
    if (remainder === 0) return;
    this.offset += alignment - remainder;
  }

  readUInt8(): number {
    this.require(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt16(): number {
    this.require(2);
    const value = this.little ? this.buffer.readUInt16LE(this.offset) : this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readUInt32(): number {
    this.require(4);
    const value = this.little ? this.buffer.readUInt32LE(this.offset) : this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt16(): number {
    this.require(2);
    const value = this.little ? this.buffer.readInt16LE(this.offset) : this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt32(): number {
    this.require(4);
    const value = this.little ? this.buffer.readInt32LE(this.offset) : this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt64(): bigint {
    this.require(8);
    const value = this.little ? this.buffer.readBigInt64LE(this.offset) : this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readUInt64(): bigint {
    this.require(8);
    const value = this.little ? this.buffer.readBigUInt64LE(this.offset) : this.buffer.readBigUInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readDouble(): number {
    this.require(8);
    const value = this.little ? this.buffer.readDoubleLE(this.offset) : this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  readBytes(length: number): Buffer {
    this.require(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private require(count: number): void {
    if (count < 0 || this.offset + count > this.buffer.length) {
      throw new DbusError(
        'org.freedesktop.DBus.Error.InvalidArgs',
        `Truncated D-Bus message: ${count} byte(s) requested at offset ${this.offset}.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Value conversion helpers
 * ------------------------------------------------------------------ */

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return `${typeof value} (${String(value)})`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `Expected a number but received ${describeValue(value)}.`,
  );
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new DbusError(
        'org.freedesktop.DBus.Error.InvalidArgs',
        `Expected an integer but received ${describeValue(value)}.`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return BigInt(value);
    } catch {
      throw new DbusError(
        'org.freedesktop.DBus.Error.InvalidArgs',
        `Expected an integer but received ${describeValue(value)}.`,
      );
    }
  }
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `Expected an integer but received ${describeValue(value)}.`,
  );
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `Expected a boolean but received ${describeValue(value)}.`,
  );
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `Expected a string but received ${describeValue(value)}.`,
  );
}

function itemsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `Expected an array but received ${describeValue(value)}.`,
  );
}

function entriesOf(value: unknown): [unknown, unknown][] {
  if (value instanceof Map) return [...value.entries()];
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>);
  }
  throw new DbusError(
    'org.freedesktop.DBus.Error.InvalidArgs',
    `Expected a dictionary but received ${describeValue(value)}.`,
  );
}

function isVariant(value: unknown): value is DBusVariant {
  return (
    typeof value === 'object' &&
    value !== null &&
    'signature' in value &&
    'value' in value &&
    typeof (value as DBusVariant).signature === 'string'
  );
}

/* ------------------------------------------------------------------ *
 * Marshalling
 * ------------------------------------------------------------------ */

/** Marshal a single basic value. */
function marshalBasic(writer: ByteWriter, code: DbusTypeCode, value: unknown): void {
  switch (code) {
    case 'y':
      writer.writeUInt8(toNumber(value));
      return;
    case 'b':
      writer.writeUInt32LE(toBoolean(value) ? 1 : 0);
      return;
    case 'n':
      writer.writeInt16LE(toNumber(value));
      return;
    case 'q':
      writer.writeUInt16LE(toNumber(value));
      return;
    case 'i':
      writer.writeInt32LE(toNumber(value));
      return;
    case 'u':
      writer.writeUInt32LE(toNumber(value));
      return;
    case 'x':
      writer.writeInt64LE(toBigInt(value));
      return;
    case 't':
      writer.writeUInt64LE(toBigInt(value));
      return;
    case 'd':
      writer.writeDoubleLE(toNumber(value));
      return;
    case 'h':
      writer.writeUInt32LE(toNumber(value));
      return;
    case 's':
    case 'o': {
      const text = Buffer.from(toText(value), 'utf8');
      writer.writeUInt32LE(text.length);
      writer.writeBytes(text);
      writer.writeUInt8(0);
      return;
    }
    case 'g': {
      const text = Buffer.from(toText(value), 'ascii');
      writer.writeUInt8(text.length);
      writer.writeBytes(text);
      writer.writeUInt8(0);
      return;
    }
  }
}

/** Marshal a value of an arbitrary (parsed) type. */
function marshalType(writer: ByteWriter, type: DbusTypeNode, value: unknown): void {
  switch (type.kind) {
    case 'basic':
      marshalBasic(writer, type.code, value);
      return;
    case 'variant': {
      if (!isVariant(value)) {
        throw new DbusError(
          'org.freedesktop.DBus.Error.InvalidArgs',
          `Expected a variant but received ${describeValue(value)}.`,
        );
      }
      const parts = splitSignature(value.signature);
      if (parts.length !== 1) {
        throw new DbusError(
          'org.freedesktop.DBus.Error.InvalidArgs',
          `A variant must carry exactly one complete type, received "${value.signature}".`,
        );
      }
      const inner = parseType(value.signature, 0).type;
      marshalBasic(writer, 'g', value.signature);
      writer.align(alignmentOf(inner));
      marshalType(writer, inner, value.value);
      return;
    }
    case 'array': {
      const nested = new ByteWriter(128);
      if (type.element.kind === 'dict') {
        for (const [key, entryValue] of entriesOf(value)) {
          nested.align(8);
          marshalType(nested, type.element.key, key);
          marshalType(nested, type.element.value, entryValue);
          nested.align(8);
        }
      } else {
        for (const item of itemsOf(value)) {
          marshalType(nested, type.element, item);
        }
      }
      const data = nested.toBuffer();
      writer.writeUInt32LE(data.length);
      writer.align(alignmentOf(type.element));
      writer.writeBytes(data);
      return;
    }
    case 'struct': {
      const members = itemsOf(value);
      writer.align(8);
      type.members.forEach((member, index) => {
        marshalType(writer, member, members[index]);
      });
      writer.align(8);
      return;
    }
    case 'dict': {
      writer.align(8);
      const [key, entryValue] = entriesOf(value)[0] ?? [];
      marshalType(writer, type.key, key);
      marshalType(writer, type.value, entryValue);
      writer.align(8);
      return;
    }
  }
}

/** Unmarshal a value of an arbitrary (parsed) type. */
function unmarshalType(reader: ByteReader, type: DbusTypeNode): unknown {
  switch (type.kind) {
    case 'basic':
      switch (type.code) {
        case 'y':
          return reader.readUInt8();
        case 'b':
          return reader.readUInt32() !== 0;
        case 'n':
          return reader.readInt16();
        case 'q':
          return reader.readUInt16();
        case 'i':
          return reader.readInt32();
        case 'u':
          return reader.readUInt32();
        case 'x':
          return reader.readInt64();
        case 't':
          return reader.readUInt64();
        case 'd':
          return reader.readDouble();
        case 'h':
          return reader.readUInt32();
        case 's':
        case 'o': {
          const length = reader.readUInt32();
          const bytes = reader.readBytes(length);
          reader.readUInt8();
          return bytes.toString('utf8');
        }
        case 'g': {
          const length = reader.readUInt8();
          const bytes = reader.readBytes(length);
          reader.readUInt8();
          return bytes.toString('ascii');
        }
      }
      return undefined;
    case 'variant': {
      const signature = unmarshalType(reader, { kind: 'basic', code: 'g' });
      if (typeof signature !== 'string') {
        throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', 'Malformed variant signature.');
      }
      const inner = parseType(signature, 0).type;
      reader.align(alignmentOf(inner));
      return { signature, value: unmarshalType(reader, inner) };
    }
    case 'array': {
      const length = reader.readUInt32();
      reader.align(alignmentOf(type.element));
      const data = reader.readBytes(length);
      const nested = new ByteReader(data, 0, true);
      if (type.element.kind === 'dict') {
        const map = new Map<unknown, unknown>();
        while (nested.offset < data.length) {
          const key = unmarshalType(nested, type.element.key);
          const value = unmarshalType(nested, type.element.value);
          nested.align(8);
          map.set(key, value);
        }
        return map;
      }
      const list: unknown[] = [];
      while (nested.offset < data.length) {
        list.push(unmarshalType(nested, type.element));
      }
      return list;
    }
    case 'struct': {
      reader.align(8);
      const members = type.members.map((member) => unmarshalType(reader, member));
      reader.align(8);
      return members;
    }
    case 'dict': {
      reader.align(8);
      const key = unmarshalType(reader, type.key);
      const value = unmarshalType(reader, type.value);
      reader.align(8);
      return new Map<unknown, unknown>([[key, value]]);
    }
  }
}

/**
 * Marshal a list of values against a (possibly empty) signature.
 *
 * The result contains the body only - without the message header.
 */
export function marshalBody(signature: string, values: readonly unknown[]): Buffer {
  const writer = new ByteWriter(128);
  const types = splitSignature(signature);
  types.forEach((type, index) => {
    marshalType(writer, parseType(type, 0).type, values[index]);
  });
  return writer.toBuffer();
}

/**
 * Unmarshal a body against a (possibly empty) signature.
 */
export function unmarshalBody(signature: string, buffer: Buffer, little = true): unknown[] {
  const values: unknown[] = [];
  const reader = new ByteReader(buffer, 0, little);
  for (const type of splitSignature(signature)) {
    values.push(unmarshalType(reader, parseType(type, 0).type));
  }
  return values;
}

/**
 * Unmarshal a single value of a complete type at the given offset.
 */
export function unmarshal(
  signature: string,
  buffer: Buffer,
  offset = 0,
  little = true,
): { value: unknown; offset: number } {
  const reader = new ByteReader(buffer, offset, little);
  const value = unmarshalType(reader, parseType(signature, 0).type);
  return { value, offset: reader.offset };
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/** The four D-Bus message types. */
export type DbusMessageType = 'method_call' | 'method_return' | 'error' | 'signal';

/** A D-Bus message. */
export interface DbusMessage {
  readonly type: DbusMessageType;
  readonly flags?: number;
  readonly serial?: number;
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly errorName?: string;
  readonly replySerial?: number;
  readonly destination?: string;
  readonly sender?: string;
  readonly signature?: string;
  readonly unixFds?: number;
  readonly body?: readonly unknown[];
}

const MESSAGE_TYPE_CODE: Record<DbusMessageType, number> = {
  method_call: 1,
  method_return: 2,
  error: 3,
  signal: 4,
};

const HEADER_FIELD = {
  PATH: 1,
  INTERFACE: 2,
  MEMBER: 3,
  ERROR_NAME: 4,
  REPLY_SERIAL: 5,
  DESTINATION: 6,
  SENDER: 7,
  SIGNATURE: 8,
  UNIX_FDS: 9,
} as const;

const PROTOCOL_VERSION = 1;

function writeHeaderField(writer: ByteWriter, code: number, signature: string, value: unknown): void {
  writer.align(8);
  writer.writeUInt8(code);
  marshalType(writer, { kind: 'variant' }, variant(signature, value));
  writer.align(8);
}

/** Encode a message into its wire representation. */
export function encodeMessage(message: DbusMessage): Buffer {
  const body = marshalBody(message.signature ?? '', message.body ?? []);
  const fields = new ByteWriter(128);
  if (message.path !== undefined) writeHeaderField(fields, HEADER_FIELD.PATH, 'o', message.path);
  if (message.interface !== undefined) writeHeaderField(fields, HEADER_FIELD.INTERFACE, 's', message.interface);
  if (message.member !== undefined) writeHeaderField(fields, HEADER_FIELD.MEMBER, 's', message.member);
  if (message.errorName !== undefined) writeHeaderField(fields, HEADER_FIELD.ERROR_NAME, 's', message.errorName);
  if (message.replySerial !== undefined) writeHeaderField(fields, HEADER_FIELD.REPLY_SERIAL, 'u', message.replySerial);
  if (message.destination !== undefined) writeHeaderField(fields, HEADER_FIELD.DESTINATION, 's', message.destination);
  if (message.sender !== undefined) writeHeaderField(fields, HEADER_FIELD.SENDER, 's', message.sender);
  if (message.signature !== undefined) writeHeaderField(fields, HEADER_FIELD.SIGNATURE, 'g', message.signature);
  if (message.unixFds !== undefined) writeHeaderField(fields, HEADER_FIELD.UNIX_FDS, 'u', message.unixFds);
  const fieldData = fields.toBuffer();

  const writer = new ByteWriter(256);
  writer.writeUInt8(0x6c); // little endian
  writer.writeUInt8(MESSAGE_TYPE_CODE[message.type]);
  writer.writeUInt8(message.flags ?? 0);
  writer.writeUInt8(PROTOCOL_VERSION);
  writer.writeUInt32LE(body.length);
  writer.writeUInt32LE(message.serial ?? 0);
  writer.writeUInt32LE(fieldData.length);
  writer.align(8); // the header field array is a struct array
  writer.writeBytes(fieldData);
  writer.align(8); // the body always starts on an 8 byte boundary
  writer.writeBytes(body);
  return writer.toBuffer();
}

/**
 * Decode a single message.
 *
 * Returns `undefined` when the buffer does not contain a complete message
 * yet - the caller has to buffer more data and try again.
 */
export function decodeMessage(buffer: Buffer): { message: DbusMessage; length: number } | undefined {
  if (buffer.length < 16) return undefined;
  const endianness = buffer.readUInt8(0);
  const little = endianness === 0x6c;
  if (!little && endianness !== 0x42) {
    throw new DbusError('org.freedesktop.DBus.Error.InvalidArgs', 'Unsupported D-Bus message endianness.');
  }
  const reader = new ByteReader(buffer, 0, little);
  reader.offset = 4;
  const bodyLength = reader.readUInt32();
  const serial = reader.readUInt32();
  const fieldsLength = reader.readUInt32();
  reader.align(8);
  if (reader.offset + fieldsLength > buffer.length) return undefined;
  const fieldData = buffer.subarray(reader.offset, reader.offset + fieldsLength);
  reader.offset += fieldsLength;
  reader.align(8);
  const bodyStart = reader.offset;
  if (buffer.length < bodyStart + bodyLength) return undefined;

  const message: {
    type: DbusMessageType;
    flags: number;
    serial: number;
    path?: string;
    interface?: string;
    member?: string;
    errorName?: string;
    replySerial?: number;
    destination?: string;
    sender?: string;
    signature?: string;
    unixFds?: number;
    body: unknown[];
  } = {
    type: 'method_call',
    flags: buffer.readUInt8(2),
    serial,
    body: [],
  };

  const rawType = buffer.readUInt8(1);
  if (rawType === 2) message.type = 'method_return';
  else if (rawType === 3) message.type = 'error';
  else if (rawType === 4) message.type = 'signal';

  // The header field array data was already extracted without its length
  // prefix, so the elements are read one by one. Their alignment is relative
  // to the start of the array data, which is 8 byte aligned in the message.
  const fieldReader = new ByteReader(fieldData, 0, little);
  const fieldElement: DbusTypeNode = {
    kind: 'struct',
    members: [{ kind: 'basic', code: 'y' }, { kind: 'variant' }],
  };
  while (fieldReader.offset < fieldData.length) {
    const entry = unmarshalType(fieldReader, fieldElement);
    if (!Array.isArray(entry)) continue;
    const code = entry[0];
    const field = entry[1];
    if (typeof code !== 'number' || !isVariant(field)) continue;
    const value = field.value;
    switch (code) {
      case HEADER_FIELD.PATH:
        message.path = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.INTERFACE:
        message.interface = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.MEMBER:
        message.member = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.ERROR_NAME:
        message.errorName = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.REPLY_SERIAL:
        message.replySerial = typeof value === 'number' ? value : undefined;
        break;
      case HEADER_FIELD.DESTINATION:
        message.destination = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.SENDER:
        message.sender = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.SIGNATURE:
        message.signature = typeof value === 'string' ? value : undefined;
        break;
      case HEADER_FIELD.UNIX_FDS:
        message.unixFds = typeof value === 'number' ? value : undefined;
        break;
      default:
        break;
    }
  }

  const body = buffer.subarray(bodyStart, bodyStart + bodyLength);
  message.body = message.signature ? unmarshalBody(message.signature, body, little) : [];

  return { message, length: bodyStart + bodyLength };
}

/** Split a buffer into the messages it contains and the trailing remainder. */
export function parseMessages(buffer: Buffer): { messages: DbusMessage[]; rest: Buffer } {
  const messages: DbusMessage[] = [];
  let offset = 0;
  for (;;) {
    const decoded = decodeMessage(buffer.subarray(offset));
    if (!decoded) break;
    messages.push(decoded.message);
    offset += decoded.length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

/** Options accepted by {@link DbusClient}. */
export interface DbusClientOptions {
  /** Pre-built transport. When omitted a unix socket is opened. */
  transport?: DbusTransport;
  /** Bus address; defaults to `DBUS_SESSION_BUS_ADDRESS`. */
  address?: string;
  /** UID used for the SASL handshake; defaults to the current user. */
  uid?: number;
  /** Whether `NEGOTIATE_UNIX_FD` is attempted (default: true). */
  negotiateUnixFd?: boolean;
  /** Timeout for pending method calls in milliseconds (default: 25000). */
  callTimeoutMs?: number;
  /** Optional structured logger. */
  logger?: DbusLogger;
}

interface PendingCall {
  resolve: (values: unknown[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A connected D-Bus client. */
export class DbusClient {
  private readonly options: DbusClientOptions;
  private readonly logger: DbusLogger;
  private transport?: DbusTransport;
  private phase: 'idle' | 'auth' | 'bus' = 'idle';
  private closed = false;
  private serialCounter = 1;
  private streamBuffer: Buffer = Buffer.alloc(0);
  private authBuffer = '';
  private authStep: 'auth' | 'negotiate' = 'auth';
  private authResolve?: () => void;
  private authReject?: (error: Error) => void;
  private readonly pending = new Map<number, PendingCall>();
  private readonly methodCallHandlers: ((message: DbusMessage) => void)[] = [];
  private readonly signalHandlers: ((message: DbusMessage) => void)[] = [];
  private readonly closeHandlers: ((error?: Error) => void)[] = [];

  /** The unique bus name of this connection (after `Hello`). */
  uniqueName?: string;

  constructor(options: DbusClientOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Register a handler for incoming method calls. */
  onMethodCall(handler: (message: DbusMessage) => void): void {
    this.methodCallHandlers.push(handler);
  }

  /** Register a handler for incoming signals. */
  onSignal(handler: (message: DbusMessage) => void): void {
    this.signalHandlers.push(handler);
  }

  /** Register a handler that is called when the connection is closed. */
  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  /** Open the transport, authenticate and greet the bus with `Hello`. */
  async connect(): Promise<void> {
    if (this.phase === 'bus') return;
    this.closed = false;
    const transport = this.options.transport ?? (await this.createTransport());
    this.transport = transport;
    transport.on('data', (payload) => {
      if (payload instanceof Buffer) this.handleData(payload);
    });
    transport.on('close', () => {
      this.handleClose();
    });
    transport.on('error', (payload) => {
      if (payload instanceof Error) this.handleError(payload);
    });

    await this.authenticate();
    const reply = await this.call(
      'org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus',
      'Hello',
      '',
      [],
    );
    const name = reply[0];
    this.uniqueName = typeof name === 'string' ? name : undefined;
  }

  /** Close the connection and reject every pending call. */
  close(): void {
    this.transport?.end();
    this.transport = undefined;
    this.phase = 'idle';
    this.handleClose();
  }

  /** Call a method and wait for its reply. */
  call(
    destination: string,
    path: string,
    interfaceName: string,
    member: string,
    signature = '',
    body: readonly unknown[] = [],
    timeoutMs?: number,
  ): Promise<unknown[]> {
    return new Promise<unknown[]>((resolve, reject) => {
      const serial = this.nextSerial();
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(
          new DbusError(
            'org.freedesktop.DBus.Error.NoReply',
            `Timed out waiting for a reply to ${interfaceName}.${member}.`,
          ),
        );
      }, timeoutMs ?? this.options.callTimeoutMs ?? 25_000);
      this.pending.set(serial, { resolve, reject, timer });
      try {
        this.send({
          type: 'method_call',
          destination,
          path,
          interface: interfaceName,
          member,
          signature,
          body,
          serial,
        });
      } catch (error) {
        this.pending.delete(serial);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Answer an incoming method call. */
  reply(message: DbusMessage, signature = '', body: readonly unknown[] = []): void {
    this.send({
      type: 'method_return',
      replySerial: message.serial,
      destination: message.sender,
      signature,
      body,
    });
  }

  /** Answer an incoming method call with an error. */
  replyError(message: DbusMessage, errorName: string, detail?: string): void {
    this.send({
      type: 'error',
      replySerial: message.serial,
      destination: message.sender,
      errorName,
      signature: detail === undefined ? '' : 's',
      body: detail === undefined ? [] : [detail],
    });
  }

  /** Emit a signal. */
  sendSignal(
    path: string,
    interfaceName: string,
    member: string,
    signature = '',
    body: readonly unknown[] = [],
  ): number {
    return this.send({ type: 'signal', path, interface: interfaceName, member, signature, body });
  }

  /** Send a message and return its serial. */
  send(message: DbusMessage): number {
    const transport = this.transport;
    if (!transport) {
      throw new DbusError('org.freedesktop.DBus.Error.Disconnected', 'The D-Bus client is not connected.');
    }
    const serial = message.serial ?? this.nextSerial();
    transport.write(encodeMessage({ ...message, serial }));
    return serial;
  }

  private nextSerial(): number {
    const serial = this.serialCounter;
    this.serialCounter = (this.serialCounter + 1) >>> 0;
    if (this.serialCounter === 0) this.serialCounter = 1;
    return serial;
  }

  private async createTransport(): Promise<DbusTransport> {
    const address = this.options.address ?? process.env['DBUS_SESSION_BUS_ADDRESS'];
    if (!address || address.trim() === '') {
      throw new DbusError(
        'org.freedesktop.DBus.Error.NoServer',
        'DBUS_SESSION_BUS_ADDRESS is not set - no D-Bus session bus is available.',
      );
    }
    const parsed = parseBusAddress(address);
    const socket = await openUnixSocket(parsed);
    return new SocketTransport(socket);
  }

  private resolveUid(): number {
    if (this.options.uid !== undefined) return this.options.uid;
    const getuid = process.getuid;
    if (typeof getuid === 'function') {
      const uid = getuid();
      if (uid >= 0) return uid;
    }
    const info = os.userInfo();
    return info.uid >= 0 ? info.uid : 0;
  }

  private async authenticate(): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      throw new DbusError('org.freedesktop.DBus.Error.Disconnected', 'The D-Bus client is not connected.');
    }
    const handshake = new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
    this.phase = 'auth';
    this.authStep = 'auth';
    const hexUid = Buffer.from(String(this.resolveUid()), 'ascii').toString('hex');
    transport.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${hexUid}\r\n`, 'ascii')]));
    await handshake;
  }

  private beginBus(): void {
    this.transport?.write(Buffer.from('BEGIN\r\n', 'ascii'));
    this.phase = 'bus';
    const resolve = this.authResolve;
    this.authResolve = undefined;
    this.authReject = undefined;
    resolve?.();
  }

  private failAuth(detail: string): void {
    const reject = this.authReject;
    this.authResolve = undefined;
    this.authReject = undefined;
    reject?.(new DbusError('org.freedesktop.DBus.Error.AccessDenied', detail));
  }

  private handleAuthLine(line: string): void {
    if (this.authStep === 'auth') {
      if (line.startsWith('OK')) {
        if (this.options.negotiateUnixFd !== false) {
          this.authStep = 'negotiate';
          this.transport?.write(Buffer.from('NEGOTIATE_UNIX_FD\r\n', 'ascii'));
          return;
        }
        this.beginBus();
        return;
      }
      this.failAuth(`Authentication rejected: ${line}`);
      return;
    }
    if (line.startsWith('AGREE_UNIX_FD')) {
      this.beginBus();
      return;
    }
    if (line.startsWith('ERROR')) {
      this.logger.warn?.('D-Bus refused NEGOTIATE_UNIX_FD, continuing without unix fd passing.', line);
      this.beginBus();
      return;
    }
    this.failAuth(`Unexpected authentication response: ${line}`);
  }

  private handleData(chunk: Buffer): void {
    if (this.phase === 'auth') {
      this.authBuffer += chunk.toString('latin1');
      for (;;) {
        const index = this.authBuffer.indexOf('\r\n');
        if (index < 0) break;
        const line = this.authBuffer.slice(0, index).replace(/\0/g, '');
        this.authBuffer = this.authBuffer.slice(index + 2);
        this.handleAuthLine(line);
      }
      return;
    }
    this.streamBuffer = this.streamBuffer.length === 0 ? chunk : Buffer.concat([this.streamBuffer, chunk]);
    for (;;) {
      const decoded = decodeMessage(this.streamBuffer);
      if (!decoded) break;
      this.streamBuffer = this.streamBuffer.subarray(decoded.length);
      this.dispatch(decoded.message);
    }
  }

  private dispatch(message: DbusMessage): void {
    switch (message.type) {
      case 'method_return':
      case 'error': {
        const serial = message.replySerial;
        const pending = serial === undefined ? undefined : this.pending.get(serial);
        if (pending) {
          this.pending.delete(serial as number);
          clearTimeout(pending.timer);
        }
        if (message.type === 'error') {
          const detail = typeof message.body?.[0] === 'string' ? message.body[0] : undefined;
          const error = new DbusError(message.errorName ?? 'org.freedesktop.DBus.Error.Failed', detail);
          if (pending) {
            pending.reject(error);
            return;
          }
          this.logger.warn?.('Received an unmatched D-Bus error reply.', error.message);
          return;
        }
        if (pending) {
          pending.resolve([...(message.body ?? [])]);
        }
        return;
      }
      case 'method_call':
        for (const handler of this.methodCallHandlers) handler(message);
        return;
      case 'signal':
        for (const handler of this.signalHandlers) handler(message);
        return;
    }
  }

  private handleError(error: Error): void {
    this.logger.error?.('D-Bus transport error.', error.message);
    this.handleClose(error);
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.phase = 'idle';
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new DbusError(
          'org.freedesktop.DBus.Error.Disconnected',
          error ? `The D-Bus connection was closed: ${error.message}` : 'The D-Bus connection was closed.',
        ),
      );
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler(error);
  }
}

/** Open a unix socket for the given bus address. */
function openUnixSocket(address: DbusAddress): Promise<net.Socket> {
  const target = address.path ?? `\0${address.abstract ?? ''}`;
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ path: target });
    const onError = (error: Error): void => {
      socket.destroy();
      reject(
        new DbusError(
          'org.freedesktop.DBus.Error.NoServer',
          `Could not connect to the D-Bus session bus at ${address.path ?? address.abstract}: ${error.message}`,
        ),
      );
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}
