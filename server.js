import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true, limit: "6mb" }));
app.use(express.static("public"));

// ---- In-memory stores (for demo only; use Redis/DB in production) ----
const CODE_TO_SESSION = new Map(); // 4-digit code -> sessionId
const SESSION_TO_PEERS = new Map(); // sessionId -> Set of ws clients
const SESSION_EXPIRY = new Map(); // sessionId -> epoch ms expiry
const UPLOAD_STORE = new Map(); // sessionId -> { filename, mime, data(Buffer), size }
const CODE_EXPIRY_MS = 1000 * 60 * 15; // 15 min
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function cleanExpired() {
  const now = Date.now();
  for (const [code, sessionId] of CODE_TO_SESSION.entries()) {
    const exp = SESSION_EXPIRY.get(sessionId);
    if (!exp || exp < now) {
      CODE_TO_SESSION.delete(code);
      SESSION_EXPIRY.delete(sessionId);
      SESSION_TO_PEERS.delete(sessionId);
      UPLOAD_STORE.delete(sessionId);
    }
  }
}
setInterval(cleanExpired, 60 * 1000).unref();

// Generate a user-friendly 4-digit code but bind to a secret sessionId
function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function createSession() {
  let code;
  do { code = generateCode(); } while (CODE_TO_SESSION.has(code));
  const sessionId = uuidv4();
  CODE_TO_SESSION.set(code, sessionId);
  SESSION_EXPIRY.set(sessionId, Date.now() + CODE_EXPIRY_MS);
  return { code, sessionId };
}

// Create/Join endpoints
app.post("/api/session", async (req, res) => {
  const { action } = req.body || {};
  if (action !== "create") {
    return res.status(400).json({ ok: false, error: "Invalid action" });
  }
  const { code, sessionId } = createSession();
  // Generate a QR that encodes a join URL containing the 4-digit code
  const origin = req.headers["x-forwarded-proto"]
    ? `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}`
    : `${req.protocol}://${req.get("host")}`;
  const joinUrl = `${origin}/?code=${code}`;
  const qrDataURL = await QRCode.toDataURL(joinUrl, { margin: 1, scale: 6 });
  return res.json({ ok: true, code, sessionId, joinUrl, qrDataURL, expiresInSec: CODE_EXPIRY_MS / 1000 });
});

app.post("/api/resolve", (req, res) => {
  const { code } = req.body || {};
  if (!code || !CODE_TO_SESSION.has(code)) {
    return res.status(404).json({ ok: false, error: "Code not found or expired" });
  }
  const sessionId = CODE_TO_SESSION.get(code);
  const exp = SESSION_EXPIRY.get(sessionId);
  if (!exp || exp < Date.now()) {
    return res.status(410).json({ ok: false, error: "Code expired" });
  }
  return res.json({ ok: true, sessionId, expiresInSec: Math.floor((exp - Date.now())/1000) });
});

// Fallback upload (<=5 MB)
app.post("/api/upload", (req, res) => {
  const { sessionId, filename, mime, dataB64 } = req.body || {};
  if (!sessionId || !filename || !dataB64) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }
  const exp = SESSION_EXPIRY.get(sessionId);
  if (!exp || exp < Date.now()) return res.status(410).json({ ok: false, error: "Session expired" });

  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) {
    return res.status(413).json({ ok: false, error: "File exceeds 5 MB limit" });
  }
  UPLOAD_STORE.set(sessionId, { filename, mime: mime || "application/octet-stream", data: buf, size: buf.length });
  res.json({ ok: true, size: buf.length });
});

app.get("/api/download/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const file = UPLOAD_STORE.get(sessionId);
  if (!file) return res.status(404).send("No file uploaded yet.");
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.send(file.data);
});

// ---- WebSocket signaling for WebRTC ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get("sessionId");
  const exp = SESSION_EXPIRY.get(sessionId);
  if (!sessionId || !exp || exp < Date.now()) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, sessionId);
  });
});

function broadcast(sessionId, msgObj, exclude) {
  const peers = SESSION_TO_PEERS.get(sessionId);
  if (!peers) return;
  const data = JSON.stringify(msgObj);
  for (const ws of peers) {
    if (ws !== exclude && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

wss.on("connection", (ws, request, sessionId) => {
  if (!SESSION_TO_PEERS.has(sessionId)) SESSION_TO_PEERS.set(sessionId, new Set());
  const peers = SESSION_TO_PEERS.get(sessionId);
  peers.add(ws);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Forward signaling messages to the other peer(s) in this session
    const type = msg?.type;
    if (["offer", "answer", "candidate", "ready"].includes(type)) {
      broadcast(sessionId, msg, ws);
    }
  });
  ws.on("close", () => {
    peers.delete(ws);
    if (peers.size === 0) {
      SESSION_TO_PEERS.delete(sessionId);
      // Keep session alive until expiry; uploads remain available
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
