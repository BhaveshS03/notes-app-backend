import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import express from 'express';

const port = 1234;
const server = http.createServer();
const wss = new WebSocketServer({ server });
const app = express();
app.use(express.json());

const PERSISTENCE_DIR = './persistence';

// Store documents and awareness by room ID
const docs = new Map();
const awarenesses = new Map();

// Ensure persistence directory exists
if (!fs.existsSync(PERSISTENCE_DIR)) {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
}

// ---------------- Utils ----------------

// Clean room ID from URL
const cleanRoomId = (url: string) => {
  if (!url || url === '/') return 'default';
  let roomId = url.startsWith('/') ? url.slice(1) : url;
  if (roomId.startsWith('?room=')) roomId = roomId.replace('?room=', '');
  return roomId.replace(/[/\\:*?"<>|]/g, '_') || 'default';
};

// File paths for a room
const getFilePaths = (roomId: string) => ({
  snapshot: `${PERSISTENCE_DIR}/${roomId}-snapshot.bin`,
  markdown: `${PERSISTENCE_DIR}/${roomId}-markdown.txt`,
  meta: `${PERSISTENCE_DIR}/${roomId}-meta.json`
});

// Extract meta map into plain object
const getMetaObject = (doc: Y.Doc) => {
  const metaMap = doc.getMap('meta');
  const metaObj: any = {};
  metaMap.forEach((v, k) => { metaObj[k] = v; });
  return metaObj;
};

// ---------------- Persistence ----------------

const saveDocument = (doc: Y.Doc, roomId: string) => {
  try {
    const { snapshot: snapshotFile, markdown: markdownFile, meta: metaFile } = getFilePaths(roomId);

    // Save snapshot
    const snapshotData = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(snapshotFile, snapshotData);

    // Extract text
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, snapshotData);
    const ytext = tempDoc.getText('content');
    fs.writeFileSync(markdownFile, ytext.toString(), 'utf8');

    // Save meta.json
    const metaObj = getMetaObject(doc);
    fs.writeFileSync(metaFile, JSON.stringify(metaObj, null, 2), 'utf8');

    console.log(`💾 Saved room ${roomId}: snapshot, text, and meta`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to save room ${roomId}:`, err);
    return false;
  }
};

const loadDocument = (doc: Y.Doc, roomId: string) => {
  const { snapshot, markdown, meta } = getFilePaths(roomId);

  // Load snapshot
  if (fs.existsSync(snapshot)) {
    try {
      const snapshotData = fs.readFileSync(snapshot);
      if (snapshotData.length > 0) {
        Y.applyUpdate(doc, snapshotData, 'load');
        console.log(`✅ Loaded snapshot for ${roomId}`);
      }
    } catch (err) {
      console.error(`❌ Failed to load snapshot for ${roomId}:`, err);
    }
  }

  // Load text fallback
  if (fs.existsSync(markdown)) {
    try {
      const content = fs.readFileSync(markdown, 'utf8');
      if (content.length > 0) {
        doc.getText('content').insert(0, content);
        console.log(`✅ Loaded markdown for ${roomId}`);
      }
    } catch (err) {
      console.error(`❌ Failed to load markdown for ${roomId}:`, err);
    }
  }

  // Load meta.json
  if (fs.existsSync(meta)) {
    try {
      const metaObj = JSON.parse(fs.readFileSync(meta, 'utf8') || '{}');
      const metaMap = doc.getMap('meta');
      for (const k in metaObj) metaMap.set(k, metaObj[k]);
      console.log(`🗂️ Loaded meta for ${roomId}`);
    } catch (err) {
      console.error(`❌ Failed to load meta for ${roomId}:`, err);
    }
  }
};

// ---------------- Doc / Awareness ----------------

const getDoc = (roomId: string) => {
  if (docs.has(roomId)) return docs.get(roomId);

  console.log(`✨ Creating new doc for room: ${roomId}`);
  const doc = new Y.Doc();
  loadDocument(doc, roomId);

  let saveTimeout: NodeJS.Timeout;
  doc.on('update', (update, origin) => {
    if (origin !== 'load') {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => saveDocument(doc, roomId), 1000);
    }
  });

  docs.set(roomId, doc);
  return doc;
};

const getAwareness = (roomId: string) => {
  if (awarenesses.has(roomId)) return awarenesses.get(roomId);
  const doc = getDoc(roomId);
  const awareness = new Awareness(doc);
  awarenesses.set(roomId, awareness);
  return awareness;
};

// ---------------- WebSocket ----------------

const send = (conn: any, encoder: any) => {
  if (conn.readyState === conn.CONNECTING || conn.readyState === conn.OPEN) {
    conn.send(encoding.toUint8Array(encoder));
  }
};

wss.on('connection', (conn, req) => {
  const rawRoomId = req.url;
  const roomId = cleanRoomId(rawRoomId || '');
  const ip = req.socket.remoteAddress;
  console.log(`👤 Client connected from ${ip} to room ${roomId}`);

  const doc = getDoc(roomId);
  const awareness = getAwareness(roomId);

  conn.binaryType = 'arraybuffer';

  // Send sync step 1
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  send(conn, encoder);

  // Send awareness states
  const states = awareness.getStates();
  if (states.size > 0) {
    const aEnc = encoding.createEncoder();
    encoding.writeVarUint(aEnc, 1);
    encoding.writeVarUint8Array(aEnc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys()))
    );
    send(conn, aEnc);
  }

  conn.on('message', (msg: ArrayBuffer) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(msg));
      const messageType = decoding.readVarUint(decoder);
      const encoder = encoding.createEncoder();

      switch (messageType) {
        case 0:
          encoding.writeVarUint(encoder, 0);
          syncProtocol.readSyncMessage(decoder, encoder, doc, null);
          if (encoding.length(encoder) > 1) send(conn, encoder);
          break;
        case 1:
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(decoder),
            conn
          );
          break;
      }
    } catch (err) {
      console.error('Error handling WS message:', err);
    }
  });

  const updateHandler = (update: Uint8Array, origin: any) => {
    if (origin !== conn) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update);
      send(conn, enc);
    }
  };
  doc.on('update', updateHandler);

  const awarenessHandler = ({ added, updated, removed }: any, origin: any) => {
    if (origin !== conn) {
      const changed = added.concat(updated, removed);
      if (changed.length > 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 1);
        encoding.writeVarUint8Array(enc,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
        );
        send(conn, enc);
      }
    }
  };
  awareness.on('update', awarenessHandler);

  conn.on('close', () => {
    console.log(`👋 Client left room ${roomId}`);
    doc.off('update', updateHandler);
    awareness.off('update', awarenessHandler);
    awarenessProtocol.removeAwarenessStates(awareness, [conn], null);
    saveDocument(doc, roomId);
  });

  conn.on('error', (err: any) => console.error('WS error:', err));
});

// ---------------- REST API ----------------

// List active rooms
app.get('/api/active-docs', (req, res) => {
  res.json({ rooms: Array.from(docs.keys()) });
});

// Create new room / doc with owner & current_user
app.post('/api/rooms', (req, res) => {
  const { roomId: reqRoom, title, currentUser, owner } = req.body;
  const roomId = cleanRoomId(reqRoom || `room-${Date.now()}`);

  const doc = getDoc(roomId);
  const meta = doc.getMap('meta');

  const ownerData = owner || currentUser || { id: `anon-${req.ip}`, name: 'Anonymous' };

  if (!meta.get('owner')) {
    meta.set('owner', ownerData);
    meta.set('createdAt', new Date().toISOString());
    meta.set('title', title || 'Untitled');
  }

  if (currentUser) meta.set('current_user', currentUser);
  meta.set('lastModified', new Date().toISOString());
  meta.set('starred', false);

  saveDocument(doc, roomId);

  res.json({
    ok: true,
    roomId,
    meta: getMetaObject(doc)
  });
});

// ---------------- Maintenance ----------------

setInterval(() => {
  console.log(`🔄 Periodic save: ${docs.size} docs`);
  for (const [roomId, doc] of docs.entries()) saveDocument(doc, roomId);
}, 30000);

process.on('SIGINT', () => {
  console.log('📴 Shutting down...');
  for (const [roomId, doc] of docs.entries()) saveDocument(doc, roomId);
  server.close(() => process.exit(0));
});

// ---------------- Start ----------------

server.on('request', app);
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 y-websocket server at ws://localhost:${port}`);
  console.log(`📁 Persistence dir: ${PERSISTENCE_DIR}`);
});
