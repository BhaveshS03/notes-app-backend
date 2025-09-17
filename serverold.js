import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const port = 1234;
const server = http.createServer();
const wss = new WebSocketServer({ server });

const PERSISTENCE_DIR = './persistence';

// Store documents and awareness by room ID
const docs = new Map();
const awarenesses = new Map();

// Ensure persistence directory exists
if (!fs.existsSync(PERSISTENCE_DIR)) {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
}

// Function to clean room ID from URL
const cleanRoomId = (url) => {
  if (!url || url === '/') return 'default';
  
  let roomId = url.startsWith('/') ? url.slice(1) : url;
  
  if (roomId.startsWith('?room=')) {
    roomId = roomId.replace('?room=', '');
  }
  
  roomId = roomId.replace(/[/\\:*?"<>|]/g, '_');
  
  return roomId || 'default';
};

// Function to get file paths for a room
const getFilePaths = (roomId) => ({
  snapshot: `${PERSISTENCE_DIR}/${roomId}-snapshot.bin`,
  markdown: `${PERSISTENCE_DIR}/${roomId}-markdown.txt`
});

// Function to save document state
const saveDocument = (doc, roomId) => {
  try {
    const { snapshot: snapshotFile, markdown: markdownFile } = getFilePaths(roomId);

    // Save binary snapshot (for fast restore)
    const snapshotData = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(snapshotFile, snapshotData);
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, snapshotData);

    // Extract plain text from the snapshot
    const ytext = tempDoc.getText('content');
    const plainText = ytext.toString();
    fs.writeFileSync(markdownFile, plainText, 'utf8');

    console.log(
      `💾 Room ${roomId}: Snapshot saved (${snapshotData.length} bytes), text saved (${plainText.length} chars)`
    );
    return true;
  } catch (error) {
    console.error(`❌ Failed to save snapshot for room ${roomId}:`, error);
    return false;
  }
};

// Function to load document state
const loadDocument = (doc, roomId) => {
  const { snapshot, markdown } = getFilePaths(roomId);
  
  // Try to load binary snapshot first
  if (fs.existsSync(snapshot)) {
    try {
      const snapshotData = fs.readFileSync(snapshot);
      if (snapshotData.length > 0) {
        Y.applyUpdate(doc, snapshotData, 'load');
        console.log(`✅ Loaded snapshot for room: ${roomId} (${snapshotData.length} bytes)`);
        return true;
      }
    } catch (error) {
      console.error(`❌ Failed to load snapshot for room ${roomId}:`, error);
    }
  }
  
  // Fallback: try to load from markdown file
  if (fs.existsSync(markdown)) {
    try {
      const markdownContent = fs.readFileSync(markdown, 'utf8');
      if (markdownContent.length > 0) {
        const ytext = doc.getText('content');
        ytext.insert(0, markdownContent);
        console.log(`✅ Loaded markdown for room: ${roomId} (${markdownContent.length} chars)`);
        return true;
      }
    } catch (error) {
      console.error(`❌ Failed to load markdown for room ${roomId}:`, error);
    }
  }
  
  console.log(`📄 No existing data for room: ${roomId}`);
  return false;
};

// Get or create document for room
const getDoc = (roomId) => {
  if (docs.has(roomId)) {
    return docs.get(roomId);
  }

  console.log(`✨ Creating new document for room: ${roomId}`);
  const doc = new Y.Doc();
  
  // Load existing state
  loadDocument(doc, roomId);

  // Set up persistence with debouncing
  let saveTimeout;
  doc.on('update', (update, origin) => {
    if (origin !== 'load') {
      console.log(`🔄 Update received for room ${roomId}`);
      
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        saveDocument(doc, roomId);
      }, 1000);
    }
  });

  docs.set(roomId, doc);
  return doc;
};

// Get or create awareness for room
const getAwareness = (roomId) => {
  if (awarenesses.has(roomId)) {
    return awarenesses.get(roomId);
  }

  const doc = getDoc(roomId);
  const awareness = new Awareness(doc);
  awarenesses.set(roomId, awareness);
  return awareness;
};

// Send message to client
const send = (conn, encoder) => {
  if (conn.readyState === conn.CONNECTING || conn.readyState === conn.OPEN) {
    conn.send(encoding.toUint8Array(encoder));
  }
};

// Handle WebSocket connections
wss.on('connection', (conn, req) => {
  const ip = req.socket.remoteAddress;
  const rawRoomId = req.url;
  const roomId = cleanRoomId(rawRoomId);
  
  console.log(`👤 New client connected from ${ip}`);
  console.log(`   Raw URL: ${rawRoomId}`);
  console.log(`   Clean room ID: ${roomId}`);

  const doc = getDoc(roomId);
  const awareness = getAwareness(roomId);

  conn.binaryType = 'arraybuffer';

  // Send sync step 1
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0); // messageSync
  syncProtocol.writeSyncStep1(encoder, doc);
  send(conn, encoder);

  // Send awareness states
  const awarenessStates = awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, 1); // messageAwareness
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys()))
    );
    send(conn, awarenessEncoder);
  }

  // Handle incoming messages
  conn.on('message', (message) => {
    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(new Uint8Array(message));
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case 0: // messageSync
          encoding.writeVarUint(encoder, 0);
          syncProtocol.readSyncMessage(decoder, encoder, doc, null);
          if (encoding.length(encoder) > 1) {
            send(conn, encoder);
          }
          break;

        case 1: // messageAwareness
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(decoder),
            conn
          );
          break;
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  // Broadcast document updates to other clients
  const updateHandler = (update, origin) => {
    if (origin !== conn) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0); // messageSync
      syncProtocol.writeUpdate(encoder, update);
      send(conn, encoder);
    }
  };
  doc.on('update', updateHandler);

  // Broadcast awareness updates
  const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
    if (origin !== conn) {
      const changedClients = added.concat(updated, removed);
      if (changedClients.length > 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1); // messageAwareness
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
        );
        send(conn, encoder);
      }
    }
  };
  awareness.on('update', awarenessChangeHandler);

  // Handle connection close
  conn.on('close', () => {
    console.log(`👋 Client disconnected from room: ${roomId}`);
    
    // Clean up listeners
    doc.off('update', updateHandler);
    awareness.off('update', awarenessChangeHandler);
    
    // Remove awareness state
    awarenessProtocol.removeAwarenessStates(awareness, [conn], null);
    
    // Save state when client disconnects
    saveDocument(doc, roomId);
  });

  conn.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Periodic save (backup)
setInterval(() => {
  console.log(`🔄 Periodic save check - ${docs.size} active documents`);
  for (const [roomId, doc] of docs.entries()) {
    saveDocument(doc, roomId);
  }
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('📴 Shutting down server...');
  
  for (const [roomId, doc] of docs.entries()) {
    saveDocument(doc, roomId);
  }
  
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});

server.listen(port, () => {
  console.log(`🚀 y-websocket server running at ws://localhost:${port}`);
  console.log(`📁 Persistence directory: ${PERSISTENCE_DIR}`);
});