import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = http.createServer(app);

// Yjs protocol message types
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

interface RoomData {
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  clientAwarenessMap: Map<WebSocket, Set<number>>;
  createdAt: number;
}

const rooms = new Map<string, RoomData>();

function getOrCreateRoom(roomName: string): RoomData {
  let room = rooms.get(roomName);
  if (!room) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    room = {
      name: roomName,
      doc,
      awareness,
      clients: new Set(),
      clientAwarenessMap: new Map(),
      createdAt: Date.now(),
    };

    // When the room document updates, broadcast the update delta to all connected clients
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      room!.clients.forEach((client) => {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          try {
            client.send(message);
          } catch (err) {
            console.error(`Failed to send update to client in room ${roomName}:`, err);
          }
        }
      });
    });

    rooms.set(roomName, room);
  }
  return room;
}

// REST endpoints for monitoring and room management
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeRooms: rooms.size,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/rooms', (_req, res) => {
  const roomList = Array.from(rooms.entries()).map(([name, room]) => ({
    name,
    connections: room.clients.size,
    awarenessCount: room.awareness.getStates().size,
    createdAt: room.createdAt,
  }));
  res.json({ rooms: roomList });
});

// WebSocket Server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage, roomName: string) => {
  const room = getOrCreateRoom(roomName);
  room.clients.add(ws);
  room.clientAwarenessMap.set(ws, new Set());

  // 1. Initial Sync Step 1: Send current state vector to client
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, room.doc);
  ws.send(encoding.toUint8Array(syncEncoder));

  // 2. Send current awareness states to client
  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys()))
    );
    ws.send(encoding.toUint8Array(awarenessEncoder));
  }

  // Handle incoming messages from client
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const decoder = decoding.createDecoder(new Uint8Array(buffer));
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);

          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }
          break;
        }

        case MESSAGE_AWARENESS: {
          const update = decoding.readVarUint8Array(decoder);
          // Track client IDs from awareness update
          try {
            const tempDecoder = decoding.createDecoder(update);
            const len = decoding.readVarUint(tempDecoder);
            const clientIds = room.clientAwarenessMap.get(ws) || new Set();
            for (let i = 0; i < len; i++) {
              const clientId = decoding.readVarUint(tempDecoder);
              decoding.readVarUint(tempDecoder); // clock
              decoding.readVarString(tempDecoder); // JSON state
              clientIds.add(clientId);
            }
            room.clientAwarenessMap.set(ws, clientIds);
          } catch {
            // Ignore decoder peek error
          }

          awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);

          // Broadcast awareness update to other clients in room
          room.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
              encoding.writeVarUint8Array(encoder, update);
              try {
                client.send(encoding.toUint8Array(encoder));
              } catch (err) {
                console.error('Failed to broadcast awareness update:', err);
              }
            }
          });
          break;
        }

        case MESSAGE_QUERY_AWARENESS: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
              room.awareness,
              Array.from(room.awareness.getStates().keys())
            )
          );
          ws.send(encoding.toUint8Array(encoder));
          break;
        }
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    room.clients.delete(ws);
    const clientIds = room.clientAwarenessMap.get(ws);
    if (clientIds && clientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        Array.from(clientIds),
        null
      );
    }
    room.clientAwarenessMap.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error in room ${roomName}:`, err);
  });
});

// Upgrade handling for WebSockets
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // We handle routes under /ws/ e.g. /ws/engineering-rfc or /ws?room=...
  if (pathname.startsWith('/ws')) {
    let roomName = 'default';
    const subPath = pathname.replace(/^\/ws\/?/, '');
    if (subPath) {
      roomName = decodeURIComponent(subPath);
    } else if (url.searchParams.get('room')) {
      roomName = url.searchParams.get('room')!;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, roomName);
    });
  } else {
    // If not our WS route, don't destroy socket if Vite dev server might handle it,
    // otherwise destroy
    if (process.env.NODE_ENV === 'production') {
      socket.destroy();
    }
  }
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SyncScribe server is running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
