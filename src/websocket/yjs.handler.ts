import { WebSocket } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { yjsService } from '../services/yjs.service';
import { cleanRoomId } from '../utils/helpers';
import { saveDocument } from '../utils/persistence';
import { IncomingMessage } from 'http';

const send = (conn: WebSocket, encoder: encoding.Encoder) => {
  if (conn.readyState === WebSocket.CONNECTING || conn.readyState === WebSocket.OPEN) {
    conn.send(encoding.toUint8Array(encoder));
  }
};

export const handleWebSocketConnection = (conn: WebSocket, req: IncomingMessage) => {
  const rawRoomId = req.url;
  const ip = req.socket.remoteAddress;

  if (!rawRoomId) {
    console.log(`❌ Invalid room ID from ${ip}`);
    return;
  }

  const roomId = cleanRoomId(rawRoomId);
  console.log(`👤 Client connected from ${ip} to room ${roomId}`);

  const doc = yjsService.getDoc(roomId);
  const awareness = yjsService.getAwareness(roomId);

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
    encoding.writeVarUint8Array(
      aEnc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys()))
    );
    send(conn, aEnc);
  }

  // Handle messages
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

  // Broadcast updates
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
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
        );
        send(conn, enc);
      }
    }
  };
  awareness.on('update', awarenessHandler);

  // Cleanup on close
  conn.on('close', () => {
    console.log(`👋 Client left room ${roomId}`);
    doc.off('update', updateHandler);
    awareness.off('update', awarenessHandler);
    saveDocument(doc, roomId);
  });

  conn.on('error', (err: any) => console.error('WS error:', err));
};