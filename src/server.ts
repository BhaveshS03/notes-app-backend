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
import mongoose from 'mongoose';
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const port = 1234;
const server = http.createServer();
const wss = new WebSocketServer({ server });
const app = express();
app.use(express.json());
app.use(cors());

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
  console.log('Raw room ID from URL:', url);  
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
  const ip = req.socket.remoteAddress;
  
  // Check if rawRoomId is invalid before processing
  if (!rawRoomId) {
    console.log(`❌ Invalid or empty room ID from ${ip}: ${rawRoomId}`);
    return;
  }
  
  const roomId = cleanRoomId(rawRoomId);
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
    // awarenessProtocol.removeAwarenessStates(awareness, [conn], null);
    saveDocument(doc, roomId);
  });

  conn.on('error', (err: any) => console.error('WS error:', err));
});

// ---------------- REST API ----------------

// List active rooms
app.get('/api/active-docs', (req, res) => {
  const rooms = Array.from(docs.entries()).map(([roomId, doc]) => {
    const meta = doc.getMap('meta');

    return {
      roomId,
      meta: {
        title: meta.get('title') || 'Untitled',
        owner: meta.get('owner') || null,
        createdAt: meta.get('createdAt') || null,
        lastModified: meta.get('lastModified') || null,
        currentUser: meta.get('current_user') || null,
        starred: meta.get('starred') || false,
      }
    };
  });
  console.log(`📋 Active rooms: ${rooms}`);
  res.json({ rooms });
});

setInterval(() => {
  console.log(`🔄 Periodic save: ${docs.size} docs`);
  for (const [roomId, doc] of docs.entries()) saveDocument(doc, roomId);
}, 30000);

process.on('SIGINT', () => {
  console.log('📴 Shutting down...');
  for (const [roomId, doc] of docs.entries()) saveDocument(doc, roomId);
  server.close(() => process.exit(0));
});

// ----------------DB Setup---------------
const userSchema = new mongoose.Schema({
  email: {type: String, unique: true, required: true},
  name: { type: String, required: true },
  password: { type: String, required: true},
  createdAt: { type: Date, default: Date.now()},
  deletedAt: { type: Date},
  documents: [{type: String}]
});

const user = mongoose.model("User",userSchema);

const documentSchema = new mongoose.Schema({
  title: { type: String, default: "Untitled Document" },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now() },
  lastModified: { type: Date, default: Date.now() },
  starred: { type: Boolean, default: false },
  sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
});

const Document = mongoose.model("Document",documentSchema);

app.post("/api/create-doc", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded: any = jwt.verify(token, "your_jwt_secret");
    console.log("Create doc request:", { token });
    const existingUser = await user.findById(decoded.id);
    console.log("Authenticated user:", existingUser);
    if (!existingUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    console.log("Creating document for user:", existingUser.email);
    // create document
    const doc = new Document({
      title: req.body.title || "Untitled Document",
      owner: existingUser._id,
    });

    await doc.save();

    // push to user's documents
    existingUser.documents.push(doc._id.toString());
    await existingUser.save();

    res.json({
      ok: true,
      roomId: doc._id.toString(),
      meta: {
        id: existingUser._id,
        title: doc.title,
        createdAt: doc.createdAt,
        lastModified: doc.lastModified,
        owner: existingUser._id,
        starred: doc.starred,
        sharedWith: req.body.sharedWith || [], 
      },
    });
  } catch (err) {
    console.error("Error creating document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});
app.put("/api/update-doc/:roomId", async (req, res) => {
  const { title, starred } = req.body;
  const { roomId } = req.params;
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded: any = jwt.verify(token, "your_jwt_secret");
    const existingUser = await user.findById(decoded.id);
    if (!existingUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    
    const doc = await Document.findById(roomId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }
    
    // Only owner or shared users can update
    if (doc.owner.toString() !== existingUser._id.toString() && !doc.sharedWith.includes(existingUser._id)) {
      return res.status(403).json({ ok: false, error: "Not authorized to update this document" });
    }
    if (title) doc.title = title;
    if (typeof starred === 'boolean') doc.starred = starred;
    doc.lastModified = new Date();
    await doc.save();
    
    res.json({
      ok: true,
      roomId: doc._id.toString(),
      meta: {
        id: existingUser._id,
        title: doc.title,
        createdAt: doc.createdAt,
        lastModified: doc.lastModified,
        owner: doc.owner,
        starred: doc.starred,
        sharedWith: doc.sharedWith,
      },
    });
  } catch (err) {
    console.error("Error updating document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/share-doc", async (req, res) => {
  const { docId, emailId } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded: any = jwt.verify(token, "your_jwt_secret");
    const currentUser = await user.findById(decoded.id);
    console.log("Share doc request:", { token, docId, emailId });
    if (!currentUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    const doc = await Document.findById(docId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: "Document not found" });
    }
    // Only the owner can share
    if (doc.owner.toString() !== currentUser._id.toString()) {
      return res.status(403).json({ ok: false, error: "Not authorized to share this document" });
    }
    const userToShare = await user.find({ email: emailId });
    console.log("User to share with:", userToShare);
    if (userToShare.length === 0) {
      return res.status(404).json({ ok: false, error: "User to share with not found" });
    }
    const userId = userToShare[0]._id;
    if (!doc.sharedWith.includes(userId)) {
      doc.sharedWith.push(userId);
      await doc.save();
    }
    res.json({ ok: true, sharedWith: doc.sharedWith });
  } catch (err) {
    console.error("Error sharing document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});


app.post("/api/register",async (req,res)=>{
  const { fullName :name, email, password} = req.body;
  console.log("Registration attempt:", { name, email, password });
  if(!email || !name || !password){
    return res.status(400).json({ok:false,error:"Missing required fields"});
  }
  try{
    const existingUser = await user.findOne({email});  
    if(existingUser){
      return res.status(400).json({ok:false,error:"User already exists"});
    }
    const hashedPassword = await bcrypt.hash(password,10);
    const newUser = new user({email,name,password:hashedPassword});
    await newUser.save();
    const token = jwt.sign({id:newUser._id},'your_jwt_secret',{expiresIn:'12h'});
    
    res.json({ok:true,token,user:{id:newUser._id,email:newUser.email,name:newUser.name}});
  }catch(err){
    console.error("Error during registration:",err);
    res.status(500).json({ok:false,error:"Internal server error"});
  }
});

app.post("/api/login",async (req,res)=>{
  const {email,password} = req.body;
  if(!email || !password){
    return res.status(400).json({ok:false,error:"Missing required fields"});
  }
  try{
    const existingUser = await user.findOne({email});  
    if(!existingUser){
      return res.status(400).json({ok:false,error:"Invalid credentials"});
    }
    const isPasswordValid = await bcrypt.compare(password,existingUser.password);
    if(!isPasswordValid){
      return res.status(400).json({ok:false,error:"Invalid credentials"});
    }
    const token = jwt.sign({id:existingUser._id},'your_jwt_secret',{expiresIn:'12h'});
    res.json({ok:true,token,user:{id:existingUser._id,email:existingUser.email,name:existingUser.name}});
  }catch(err){
    console.error("Error during login:",err);
    res.status(500).json({ok:false,error:"Internal server error"});
  }
});

app.get("/api/profile",async (req,res)=>{
  const authHeader = req.headers.authorization;
  if(!authHeader || !authHeader.startsWith("Bearer ")){
    return res.status(401).json({ok:false,error:"Unauthorized"});
  }
  const token = authHeader.split(" ")[1];
  try{
    const decoded:any = jwt.verify(token,'your_jwt_secret');
    const existingUser = await user.findById(decoded.id);
    if(!existingUser){
      return res.status(404).json({ok:false,error:"User not found"});
    }
    res.json({ok:true,user:{id:existingUser._id,email:existingUser.email,name:existingUser.name}});
  }catch(err){
    console.error("Error during profile fetch:",err);
    res.status(500).json({ok:false,error:"Internal server error"});
  }
  if(!token){
    return res.status(401).json({ok:false,error:"Unauthorized"}); 
  }
});

app.get("/api/my-docs", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded: any = jwt.verify(token, "your_jwt_secret");
    const existingUser = await user.findById(decoded.id);
    if (!existingUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    // ✅ Fetch documents owned by user or shared with user
    const docs = await Document.find({
      $or: [
        { owner: existingUser._id },
        { sharedWith: existingUser._id }
      ]
    }).sort({ lastModified: -1 }); // optional: newest first

    res.json({
      ok: true,
      documents: docs.map(d => ({
        id: d._id,
        title: d.title,
        owner: d.owner,
        sharedWith: d.sharedWith,
        starred: d.starred,
        createdAt: d.createdAt,
        lastModified: d.lastModified,
      })),
    });
  } catch (err) {
    console.error("Error fetching documents:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ---------------- Start ----------------

server.on('request', app);
server.listen(port, '0.0.0.0', () => {
async function startServer() {
  await mongoose.connect("pass");
  console.log('Connected to MongoDB');
  console.log(`🚀 y-websocket server at ws://localhost:${port}`);
  console.log(`📁 Persistence dir: ${PERSISTENCE_DIR}`);
}

startServer();
});
