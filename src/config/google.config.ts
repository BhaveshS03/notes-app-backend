import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

let googleConfig: {
  clientID: string;
  clientSecret: string;
  callbackURL: string;
};

try {
  const jsonPath = path.resolve("google_client_secret.json");
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8")).web;
  googleConfig = {
    clientID: data.client_id,
    clientSecret: data.client_secret,
    callbackURL: data.redirect_uris[0],
  };
} catch {
  googleConfig = {
    clientID: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackURL: process.env.GOOGLE_REDIRECT_URI!,
  };
}

export default googleConfig;
