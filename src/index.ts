import http from 'http';
import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { connectDB } from './config/db';
import { PORT, PERSISTENCE_DIR } from './config/constants';
import routes from './routes';
import { handleWebSocketConnection } from './websocket/yjs.handler';
import { yjsService } from './services/yjs.service';

// Initialize Express app
const app = express();
app.use(express.json());
app.use(cors());
app.use(routes);

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });
wss.on('connection', handleWebSocketConnection);

// Ensure persistence directory exists
if (!fs.existsSync(PERSISTENCE_DIR)) {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
}

// Periodic save
setInterval(() => {
  yjsService.saveAll();
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('📴 Shutting down...');
  yjsService.saveAll();
  server.close(() => process.exit(0));
});

// Start server
const startServer = async () => {
  await connectDB();
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Persistence directory: ${PERSISTENCE_DIR}`);
  });
};

startServer();