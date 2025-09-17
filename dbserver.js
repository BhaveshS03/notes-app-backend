import http from 'http';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const port = 1234;
const server = http.createServer();
const wss = new WebSocketServer({ server });

// MongoDB Configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = 'yjs_collaboration';
const SNAPSHOTS_COLLECTION = 'snapshots';
const UPDATES_COLLECTION = 'updates';

// Configuration
const COMPACTION_THRESHOLD = 100; // Compact when updates exceed this number
const COMPACTION_INTERVAL = 5 * 60 * 1000; // Check for compaction every 5 minutes
const UPDATE_BATCH_SIZE = 50; // Process updates in batches

// Store documents and awareness by room ID
const docs = new Map();
const awarenesses = new Map();
const documentSeqCounters = new Map(); // Track sequence numbers per room

// MongoDB client
let mongoClient;
let db;
let snapshotsCollection;
let updatesCollection;

// Initialize MongoDB connection
async function initMongoDB() {
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db(DATABASE_NAME);
    snapshotsCollection = db.collection(SNAPSHOTS_COLLECTION);
    updatesCollection = db.collection(UPDATES_COLLECTION);
    
    // Create indexes for better performance
    await snapshotsCollection.createIndex({ roomId: 1 }, { unique: true });
    await snapshotsCollection.createIndex({ createdAt: 1 });
    
    await updatesCollection.createIndex({ roomId: 1, seq: 1 }, { unique: true });
    await updatesCollection.createIndex({ roomId: 1, createdAt: 1 });
    await updatesCollection.createIndex({ createdAt: 1 }); // For cleanup
    
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    throw error;
  }
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

// Get next sequence number for a room
const getNextSeq = (roomId) => {
  const current = documentSeqCounters.get(roomId) || 0;
  const next = current + 1;
  documentSeqCounters.set(roomId, next);
  return next;
};

// Save an incremental update
const saveUpdate = async (doc, roomId, update, origin) => {
  try {
    if (!updatesCollection || origin === 'load' || origin === 'snapshot') {
      return false;
    }

    const seq = getNextSeq(roomId);
    
    // Extract text content for debugging/search purposes
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(doc));
    const ytext = tempDoc.getText('content');
    const textContent = ytext.toString();

    const updateDoc = {
      roomId: roomId,
      seq: seq,
      update: Buffer.from(update),
      textContent: textContent,
      createdAt: new Date(),
      size: update.length
    };

    await updatesCollection.insertOne(updateDoc);
    
    console.log(`📝 Room ${roomId}: Update ${seq} saved (${update.length} bytes)`);
    
    // Check if we need compaction
    const updateCount = await updatesCollection.countDocuments({ roomId });
    if (updateCount >= COMPACTION_THRESHOLD) {
      console.log(`🔄 Room ${roomId}: Scheduling compaction (${updateCount} updates)`);
      // Schedule compaction asynchronously
      setImmediate(() => compactDocument(roomId));
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to save update for room ${roomId}:`, error);
    return false;
  }
};

// Create a new snapshot and remove old updates
const compactDocument = async (roomId) => {
  try {
    console.log(`🗜️ Starting compaction for room: ${roomId}`);
    
    const doc = docs.get(roomId);
    if (!doc) {
      console.log(`⚠️ No active document found for room: ${roomId}`);
      return false;
    }

    // Create new snapshot
    const stateVector = Y.encodeStateVector(doc);
    const documentState = Y.encodeStateAsUpdate(doc);
    
    // Extract text content
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, documentState);
    const ytext = tempDoc.getText('content');
    const textContent = ytext.toString();
    
    const currentSeq = documentSeqCounters.get(roomId) || 0;
    
    const snapshotDoc = {
      roomId: roomId,
      stateVector: Buffer.from(stateVector),
      documentState: Buffer.from(documentState),
      textContent: textContent,
      snapshotSeq: currentSeq,
      createdAt: new Date(),
      size: documentState.length
    };

    // Use transaction to ensure atomicity
    const session = mongoClient.startSession();
    
    try {
      await session.withTransaction(async () => {
        // Replace the snapshot
        await snapshotsCollection.replaceOne(
          { roomId: roomId },
          snapshotDoc,
          { upsert: true, session }
        );
        
        // Remove all updates for this room (they're now included in the snapshot)
        const deleteResult = await updatesCollection.deleteMany(
          { roomId: roomId },
          { session }
        );
        
        console.log(
          `✅ Room ${roomId}: Compaction complete - ` +
          `snapshot created (${documentState.length} bytes), ` +
          `${deleteResult.deletedCount} updates removed`
        );
      });
    } finally {
      await session.endSession();
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Compaction failed for room ${roomId}:`, error);
    return false;
  }
};

// Load document from snapshot + updates
const loadDocument = async (doc, roomId) => {
  try {
    if (!snapshotsCollection || !updatesCollection) {
      console.error('❌ MongoDB not initialized');
      return false;
    }

    // Load the latest snapshot
    const snapshot = await snapshotsCollection.findOne({ roomId: roomId });
    let snapshotSeq = 0;
    
    if (snapshot) {
      // Apply the snapshot
      if (snapshot.documentState && snapshot.documentState.buffer) {
        const uint8Array = new Uint8Array(snapshot.documentState.buffer);
        Y.applyUpdate(doc, uint8Array, 'snapshot');
        snapshotSeq = snapshot.snapshotSeq || 0;
        
        console.log(
          `📸 Room ${roomId}: Snapshot loaded (seq: ${snapshotSeq}, ` +
          `${uint8Array.length} bytes, created: ${snapshot.createdAt})`
        );
      }
    }
    
    // Load updates that came after the snapshot
    const updates = await updatesCollection
      .find({ 
        roomId: roomId,
        seq: { $gt: snapshotSeq }
      })
      .sort({ seq: 1 })
      .toArray();
    
    if (updates.length > 0) {
      // Apply updates in sequence order
      for (const updateDoc of updates) {
        if (updateDoc.update && updateDoc.update.buffer) {
          const uint8Array = new Uint8Array(updateDoc.update.buffer);
          Y.applyUpdate(doc, uint8Array, 'load');
        }
      }
      
      // Update sequence counter
      const maxSeq = Math.max(...updates.map(u => u.seq));
      documentSeqCounters.set(roomId, maxSeq);
      
      console.log(
        `🔄 Room ${roomId}: ${updates.length} updates applied ` +
        `(seq: ${snapshotSeq + 1}-${maxSeq})`
      );
    }
    
    if (snapshot || updates.length > 0) {
      return true;
    }
    
    console.log(`📄 No existing data for room: ${roomId}`);
    return false;
    
  } catch (error) {
    console.error(`❌ Failed to load document for room ${roomId}:`, error);
    return false;
  }
};

// Get or create document for room
const getDoc = async (roomId) => {
  if (docs.has(roomId)) {
    return docs.get(roomId);
  }

  console.log(`✨ Creating new document for room: ${roomId}`);
  const doc = new Y.Doc();
  
  // Load existing state from MongoDB
  await loadDocument(doc, roomId);

  // Set up update handler to save incremental updates
  doc.on('update', async (update, origin) => {
    if (origin !== 'load' && origin !== 'snapshot') {
      console.log(`🔄 Update received for room ${roomId}`);
      await saveUpdate(doc, roomId, update, origin);
    }
  });

  docs.set(roomId, doc);
  return doc;
};

// Get or create awareness for room
const getAwareness = async (roomId) => {
  if (awarenesses.has(roomId)) {
    return awarenesses.get(roomId);
  }

  const doc = await getDoc(roomId);
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
wss.on('connection', async (conn, req) => {
  const ip = req.socket.remoteAddress;
  const rawRoomId = req.url;
  const roomId = cleanRoomId(rawRoomId);
  
  console.log(`👤 New client connected from ${ip}`);
  console.log(`   Raw URL: ${rawRoomId}`);
  console.log(`   Clean room ID: ${roomId}`);

  try {
    const doc = await getDoc(roomId);
    const awareness = await getAwareness(roomId);

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
    conn.on('close', async () => {
      console.log(`👋 Client disconnected from room: ${roomId}`);
      
      // Clean up listeners
      doc.off('update', updateHandler);
      awareness.off('update', awarenessChangeHandler);
      
      // Remove awareness state
      awarenessProtocol.removeAwarenessStates(awareness, [conn], null);
    });

    conn.on('error', (err) => {
      console.error('WebSocket error:', err);
    });

  } catch (error) {
    console.error(`❌ Error handling connection for room ${roomId}:`, error);
    conn.close();
  }
});

// Periodic compaction check
setInterval(async () => {
  try {
    console.log(`🔍 Checking for documents needing compaction...`);
    
    // Find rooms with many updates
    const pipeline = [
      { $group: { _id: '$roomId', updateCount: { $sum: 1 } } },
      { $match: { updateCount: { $gte: COMPACTION_THRESHOLD } } }
    ];
    
    const roomsNeedingCompaction = await updatesCollection.aggregate(pipeline).toArray();
    
    for (const { _id: roomId } of roomsNeedingCompaction) {
      if (docs.has(roomId)) {
        console.log(`🗜️ Compacting room: ${roomId}`);
        await compactDocument(roomId);
      }
    }
    
  } catch (error) {
    console.error('❌ Error during compaction check:', error);
  }
}, COMPACTION_INTERVAL);

// Cleanup old data
setInterval(async () => {
  try {
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    
    // Remove old snapshots for inactive rooms
    const snapshotResult = await snapshotsCollection.deleteMany({
      createdAt: { $lt: cutoffDate }
    });
    
    // Remove old updates for inactive rooms  
    const updateResult = await updatesCollection.deleteMany({
      createdAt: { $lt: cutoffDate }
    });
    
    if (snapshotResult.deletedCount > 0 || updateResult.deletedCount > 0) {
      console.log(
        `🗑️ Cleaned up ${snapshotResult.deletedCount} old snapshots ` +
        `and ${updateResult.deletedCount} old updates`
      );
    }
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}, 24 * 60 * 60 * 1000); // Run daily

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('📴 Shutting down server...');
  
  // Close MongoDB connection
  if (mongoClient) {
    await mongoClient.close();
    console.log('📦 MongoDB connection closed');
  }
  
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});

// Start the server
async function startServer() {
  try {
    await initMongoDB();
    
    server.listen(port, () => {
      console.log(`🚀 y-websocket server running at ws://localhost:${port}`);
      console.log(`📦 Using MongoDB: ${MONGODB_URI}/${DATABASE_NAME}`);
      console.log(`🗜️ Compaction threshold: ${COMPACTION_THRESHOLD} updates`);
      console.log(`⏰ Compaction check interval: ${COMPACTION_INTERVAL / 1000}s`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();