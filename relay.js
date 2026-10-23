#!/usr/bin/env node
/**
 * DSH Mobile Relay.
 *
 * A zero-knowledge TCP rendezvous: a desktop companion registers a room, a
 * phone joins the same room, and the relay forwards opaque framed streams
 * between them. Payloads are encrypted end to end with a key the relay never
 * receives; it only reads the routing header (channel, stream, type, length).
 *
 * Wire format
 *   handshake  4-byte big-endian length + UTF-8 JSON
 *   frame      1 byte channel | 4 bytes stream | 1 byte type | 2 bytes length | payload
 *
 * Usage: node relay.js [--port 9443] [--host 0.0.0.0]
 */

import net from 'node:net';

const FRAME_HEADER = 8;
const MAX_FRAME = 65535;
const MAX_HANDSHAKE = 4096;
const MAX_CLIENTS = 16;
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;

const TYPE = {
  HELLO: 0,
  OPEN: 1,
  DATA: 2,
  FIN: 3,
  RST: 4,
  PING: 5,
  CHANNEL_CLOSED: 6,
};

function log(...parts) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}]`, ...parts);
}

function parseArgs(argv) {
  const options = { port: 9443, host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') options.port = Number(argv[++i]);
    else if (flag === '--host') options.host = argv[++i];
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node relay.js [--port 9443] [--host 0.0.0.0]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error('relay: --port must be a TCP port');
  }
  return options;
}

class ByteReader {
  constructor(iterator) {
    this.iterator = iterator;
    this.buffer = Buffer.alloc(0);
  }

  async read(length) {
    while (this.buffer.length < length) {
      const { value, done } = await this.iterator.next();
      if (done) throw new Error('eof');
      this.buffer = this.buffer.length === 0 ? value : Buffer.concat([this.buffer, value]);
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }
}

async function writeAll(socket, buffer) {
  if (socket.destroyed) return false;
  if (socket.write(buffer)) return true;
  await new Promise((resolve) => {
    const done = () => {
      socket.off('drain', done);
      socket.off('close', done);
      resolve();
    };
    socket.once('drain', done);
    socket.once('close', done);
  });
  return !socket.destroyed;
}

function frame(channel, stream, type, payload) {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(FRAME_HEADER);
  header[0] = channel & 0xff;
  header.writeUInt32BE(stream >>> 0, 1);
  header[5] = type & 0xff;
  header.writeUInt16BE(body.length, 6);
  return body.length === 0 ? header : Buffer.concat([header, body]);
}

const rooms = new Map();

function roomFor(id) {
  let room = rooms.get(id);
  if (room === undefined) {
    room = { host: null, clients: new Map(), nextChannel: 1 };
    rooms.set(id, room);
  }
  return room;
}

function closeQuietly(socket) {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
}

function attachHost(socket, reader, roomId, room) {
  room.host = socket;
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  log(`host online   ${roomId.slice(0, 8)}`);

  socket.on('close', () => {
    if (room.host !== socket) return;
    room.host = null;
    for (const client of room.clients.values()) closeQuietly(client.socket);
    room.clients.clear();
    if (room.clients.size === 0) rooms.delete(roomId);
    log(`host offline  ${roomId.slice(0, 8)}`);
  });

  void (async () => {
    try {
      for (;;) {
        const header = await reader.read(FRAME_HEADER);
        const channel = header[0];
        const length = header.readUInt16BE(6);
        const payload = length === 0 ? null : await reader.read(length);
        const client = room.clients.get(channel);
        if (client === undefined) {
          // Host heartbeat (channel 0): echo it so the desktop can detect a
          // dead link even when no phone is sending traffic.
          if (header[5] === TYPE.PING && !socket.destroyed) {
            await writeAll(socket, header).catch(() => {});
          }
          continue;
        }
        // Never await a client write here: one slow phone would otherwise
        // stall the host's read loop and every other client behind it.
        if (client.socket.writableLength > MAX_CLIENT_BUFFER) {
          closeQuietly(client.socket);
          continue;
        }
        client.socket.write(payload === null ? header : Buffer.concat([header, payload]));
      }
    } catch {
      /* connection ended */
    }
  })();
}

function attachClient(socket, reader, roomId, room, channel, salt) {
  const client = { socket, channel };
  room.clients.set(channel, client);
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  log(`client online ${roomId.slice(0, 8)} channel=${channel}`);

  void writeAll(room.host, frame(channel, 0, TYPE.HELLO, salt)).catch(() => {});

  socket.on('close', () => {
    if (room.clients.get(channel) !== client) return;
    room.clients.delete(channel);
    if (room.host !== null) {
      void writeAll(room.host, frame(channel, 0, TYPE.CHANNEL_CLOSED)).catch(() => {});
    }
    log(`client offline ${roomId.slice(0, 8)} channel=${channel}`);
  });

  void (async () => {
    try {
      for (;;) {
        const header = await reader.read(FRAME_HEADER);
        const length = header.readUInt16BE(6);
        const payload = length === 0 ? null : await reader.read(length);
        if (room.host === null) break;
        header[0] = channel;
        await writeAll(room.host, payload === null ? header : Buffer.concat([header, payload]));
      }
    } catch {
      /* connection ended */
    }
  })();
}

function allocateChannel(room) {
  for (let attempt = 0; attempt < 255; attempt += 1) {
    const channel = room.nextChannel;
    room.nextChannel = channel >= 255 ? 1 : channel + 1;
    if (!room.clients.has(channel)) return channel;
  }
  return 0;
}

async function handleConnection(socket) {
  socket.setNoDelay(true);
  const iterator = socket[Symbol.asyncIterator]();
  const reader = new ByteReader(iterator);
  let roomId = null;

  try {
    const header = await reader.read(4);
    const length = header.readUInt32BE(0);
    if (length === 0 || length > MAX_HANDSHAKE) throw new Error('bad handshake length');
    const hello = JSON.parse((await reader.read(length)).toString('utf8'));
    if (hello?.v !== 1 || typeof hello.room !== 'string' || !/^[0-9a-f]{16,64}$/i.test(hello.room)) {
      throw new Error('bad handshake');
    }
    roomId = hello.room.toLowerCase();

    if (hello.role === 'host') {
      const room = roomFor(roomId);
      if (room.host !== null) {
        await writeAll(socket, handshakeReply({ ok: false, error: 'room-busy' }));
        closeQuietly(socket);
        return;
      }
      await writeAll(socket, handshakeReply({ ok: true }));
      attachHost(socket, reader, roomId, room);
      return;
    }

    if (hello.role === 'client') {
      const room = rooms.get(roomId);
      if (room === undefined || room.host === null) {
        await writeAll(socket, handshakeReply({ ok: false, error: 'host-offline' }));
        closeQuietly(socket);
        return;
      }
      if (room.clients.size >= MAX_CLIENTS) {
        await writeAll(socket, handshakeReply({ ok: false, error: 'room-full' }));
        closeQuietly(socket);
        return;
      }
      const salt = typeof hello.salt === 'string' ? Buffer.from(hello.salt, 'base64') : Buffer.alloc(0);
      if (salt.length < 8 || salt.length > 32) {
        await writeAll(socket, handshakeReply({ ok: false, error: 'bad-salt' }));
        closeQuietly(socket);
        return;
      }
      const channel = allocateChannel(room);
      if (channel === 0) {
        await writeAll(socket, handshakeReply({ ok: false, error: 'room-full' }));
        closeQuietly(socket);
        return;
      }
      await writeAll(socket, handshakeReply({ ok: true, channel }));
      attachClient(socket, reader, roomId, room, channel, salt);
      return;
    }

    throw new Error('bad role');
  } catch {
    if (roomId !== null) {
      const room = rooms.get(roomId);
      if (room !== undefined && room.host === null && room.clients.size === 0) rooms.delete(roomId);
    }
    closeQuietly(socket);
  }
}

function handshakeReply(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

const options = parseArgs(process.argv.slice(2));
const server = net.createServer({ allowHalfOpen: false }, (socket) => {
  socket.on('error', () => {});
  void handleConnection(socket);
});

server.maxConnections = 512;

server.on('error', (error) => {
  console.error(`relay: ${error.message}`);
  process.exitCode = 1;
});

server.listen(options.port, options.host, () => {
  log(`dsh-mobile-relay listening on ${options.host}:${options.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    for (const room of rooms.values()) {
      if (room.host !== null) closeQuietly(room.host);
      for (const client of room.clients.values()) closeQuietly(client.socket);
    }
    setTimeout(() => process.exit(0), 500).unref();
  });
}
