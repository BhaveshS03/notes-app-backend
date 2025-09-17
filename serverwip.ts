import { WebSocketServer, WebSocket } from "ws";

const port = 1234;
const wss = new WebSocketServer({ port });

const handleMessage = (data: any, isBinary: boolean) => {
  console.log("MESSAGE --", isBinary ? data : data.toString());
};

const handleConnection = (conn: WebSocket, req: any) => {
  console.log("Yo!");
  
  const ip = req.socket.remoteAddress;
  const roomId = req.url;
  console.log(`👤 New client connected from ${ip}`);
  console.log(`   room ID: ${roomId}`);

  conn.on("message", handleMessage);
  conn.on("close", handleClose);
};

const handleClose = () => {
  console.log("Quit");
};

wss.on("connection", handleConnection);

console.log(`WebSocket server running on ws://localhost:${port}`);
