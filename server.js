import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import * as Y from 'yjs';
import { setupWSConnection } from '@y/websocket-server/utils';
import { Awareness } from 'y-protocols/awareness.js';

const port = 1234;
const server = http.createServer();
const doc = new Y.Doc();
const awareness = new Awareness(doc);
const wss = new WebSocketServer({ server });

const PERSISTENCE_FILE = './doc-updates.bin';
const SNAPSHOT_FILE = './doc-snapshot.bin';

// ---- Load snapshot first ----
if (fs.existsSync(SNAPSHOT_FILE)) {
  const snapshot = fs.readFileSync(SNAPSHOT_FILE);
  Y.applyUpdate(doc, snapshot);
  console.log('✅ Loaded snapshot from disk.');
}
// (optional) replay incremental updates after snapshot here...

// ---- Save incremental updates ----
doc.on('update', (update) => {
  // Append incremental update
  fs.appendFileSync(PERSISTENCE_FILE, update);

  // Also save a fresh snapshot (overwrite)
  const snapshot = Y.encodeStateAsUpdate(doc);
  fs.writeFileSync(SNAPSHOT_FILE, snapshot);

  console.log('💾 Update applied & snapshot written.');
});

// ---- Handle new client connections ----
wss.on('connection', (conn, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`👤 New client connected from ${ip}`);

  setupWSConnection(conn, req, { doc, awareness });

  awareness.on('update', ({ added, updated, removed }) => {
    if (added.length > 0) console.log(`✅ Users joined: ${added}`);
    if (updated.length > 0) console.log(`🔄 Users updated: ${updated}`);
    if (removed.length > 0) console.log(`❌ Users left: ${removed}`);
  });
});

server.listen(port, () => {
  console.log(`🚀 y-websocket server running at ws://localhost:${port}`);
});
