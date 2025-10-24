import http from "http";
import { WebSocketServer } from "ws";
import express from "express";
import cors from "cors";
import fs from "fs";
import { connectDB } from "./config/db";
import { PORT, PERSISTENCE_DIR } from "./config/constants";
import routes from "./routes";
import { handleWebSocketConnection } from "./websocket/yjs.handler";
import { yjsService } from "./services/yjs.service";
import googleConfig from "./config/google.config";
import passport from "passport";
import session from "express-session";
import { User } from "./models/User";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

// Initialize Express app
const app = express();
app.use(
  cors({
    origin: [
      "https://gentle-elf-19ba24.netlify.app",
      "https://main.d220red9g3z692.amplifyapp.com",
    ],
    credentials: true,
  }),
);
app.use(express.json());
app.use(routes);

app.use(
  session({
    secret: process.env.EXPRESS_SECRET || "",
    resave: false,
    saveUninitialized: true,
  }),
);
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: "/api/google/login",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user already exists
        let user = await User.findOne({ email: profile.emails?.[0]?.value });

        if (user) {
          // User exists, return them
          return done(null, user);
        } else {
          // Create new user
          user = new User({
            name: profile.displayName,
            email: profile.emails?.[0]?.value,
            password: "", // No password for OAuth users
            googleId: profile.id,
          });

          await user.save();
          return done(null, user);
        }
      } catch (err) {
        return done(err, false);
      }
    },
  ),
);

// Serialize user for session (if using sessions)
passport.serializeUser((user: any, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });
wss.on("connection", handleWebSocketConnection);

// Ensure persistence directory exists
if (!fs.existsSync(PERSISTENCE_DIR)) {
  fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
}

// Periodic save
setInterval(() => {
  yjsService.saveAll();
}, 30000);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("📴 Shutting down...");
  yjsService.saveAll();
  server.close(() => process.exit(0));
});

// Start server
const startServer = async () => {
  await connectDB();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Persistence directory: ${PERSISTENCE_DIR}`);
  });
};

startServer();
