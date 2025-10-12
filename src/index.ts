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
import googleConfig from "./config/google.config";
import passport from "passport";
import session from "express-session";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

// Initialize Express app
const app = express();
app.use(express.json());
app.use(cors());
app.use(routes);

app.use(session({ secret: process.env.EXPRESS_SECRET || "", resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

// Setup Google OAuth
passport.use(
  new GoogleStrategy(
    googleConfig,
    async (accessToken, refreshToken, profile, done) => {
      try {
        console.log(accessToken, profile);
        done(null, profile);
      } catch (err) {
        done(err, false);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, false));

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