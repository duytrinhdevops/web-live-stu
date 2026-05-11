const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");
const viewComment      = require("./modules/view_comment");
const googleRead       = require("./modules/google_read");
const translateOverlay = require("./modules/translate_overlay");
const speechTranslate  = require("./modules/speech_translate");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const CONFIG_DIR = path.join(__dirname, "configs");
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Room state ────────────────────────────────────────────────────────────

function defaultState() {
  return {
    tiktokUniqueId: "",
    allX: 0, allY: 0, allScale: 1,
    jarWidth: 1, jarHeight: 1, jarBaseX: 0, jarBaseY: 0, jarImageUrl: null,
    giftWidth: 1, giftHeight: 1, giftBaseX: 0, giftBaseY: 0,
    giftSize: 1, giftBounce: 0.02, giftFriction: 0.6,
    mouthOpacity: 0, mouthX: 0, mouthY: 0, mouthScale: 1,
    ...viewComment.DEFAULT_STATE,
    ...googleRead.DEFAULT_STATE,
    ...translateOverlay.DEFAULT_STATE,
    ...speechTranslate.DEFAULT_STATE,
    stickers: Array(5).fill(null).map(() => ({ imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 }))
  };
}

const rooms = new Map(); // roomId → { id, state, connection, isConnected }

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function createRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  const room = { id: roomId, state: defaultState(), connection: null, isConnected: false };
  loadRoomConfig(room);
  applyAllOffset(room);
  rooms.set(roomId, room);
  return room;
}

function getRoomConfigPath(roomId) {
  return path.join(CONFIG_DIR, `config_${roomId}.json`);
}

function loadRoomConfig(room) {
  try {
    const cfgPath = getRoomConfigPath(room.id);
    if (!fs.existsSync(cfgPath)) return;
    const parsed   = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const fallback = defaultState();
    room.state = {
      ...fallback,
      ...parsed,
      stickers: Array.isArray(parsed.stickers) && parsed.stickers.length === 5
        ? parsed.stickers.map(s => ({ imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0, ...s }))
        : fallback.stickers
    };
  } catch (err) {
    console.log(`[room:${room.id}] Load config failed:`, err.message);
  }
}

function saveRoomConfig(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  fs.writeFileSync(getRoomConfigPath(roomId), JSON.stringify(room.state, null, 2), "utf8");
}

// Load rooms from existing config files on startup
for (const file of fs.readdirSync(CONFIG_DIR)) {
  const m = file.match(/^config_([a-z0-9]+)\.json$/);
  if (m) createRoom(m[1]);
}

function applyAllOffset(room) {
  const allX = Number(room.state.allX || 0);
  const allY = Number(room.state.allY || 0);
  room.state.jarX  = room.state.jarBaseX  + allX;
  room.state.jarY  = room.state.jarBaseY  + allY;
  room.state.giftX = room.state.giftBaseX + allX;
  room.state.giftY = room.state.giftBaseY + allY;
  for (const s of room.state.stickers) {
    s.x = (s.baseX || 0) + allX;
    s.y = (s.baseY || 0) + allY;
  }
}

function getStickerIndex(value, room) {
  const idx = Number(value);
  if (!Number.isInteger(idx) || idx < 0 || idx >= room.state.stickers.length) return -1;
  return idx;
}

// ── TikTok connection ─────────────────────────────────────────────────────

async function disconnectRoom(roomId) {
  const room = getRoom(roomId);
  if (!room || !room.connection) return;
  speechTranslate.stopStreamCapture(roomId);
  try { await room.connection.disconnect(); } catch {}
  room.connection  = null;
  room.isConnected = false;
}

async function connectRoom(roomId, uniqueId) {
  const room    = getRoom(roomId);
  if (!room) throw new Error("Room not found");
  const cleanId = String(uniqueId || "").trim();
  if (!cleanId) throw new Error("ID TikTok không hợp lệ");

  io.to(roomId).emit("tiktokStatus", { status: "connecting", uniqueId: cleanId });
  await disconnectRoom(roomId);

  const conn = new WebcastPushConnection(cleanId, {
    processInitialData:       false,
    enableWebsocketUpgrade:   false,
    requestPollingIntervalMs: 1000
  });

  conn.on("gift", data => {
    const gift  = data.giftName || "quà";
    const count = data.repeatCount || 1;
    const user  = data.nickname || data.uniqueId || data.userDetails?.nickname || data.userDetails?.uniqueId || "Unknown";
    const giftImageUrl = data.giftPictureUrl || data.gift?.image?.url_list?.[0] || "";
    for (let i = 0; i < count; i++) {
      io.to(roomId).emit("giftDrop", { username: user, giftName: gift, imgPath: giftImageUrl });
    }
  });

  viewComment.attachChatListener(conn, roomId, io);
  googleRead.attachChatListener(conn, roomId, io, () => room.state);
  translateOverlay.attachChatListener(conn, roomId, io, () => room.state);

  conn.on("streamEnd", () => {
    room.isConnected = false;
    speechTranslate.stopStreamCapture(roomId);
    io.to(roomId).emit("tiktokStatus", { status: "live_ended", uniqueId: cleanId });
  });

  conn.on("disconnected", () => {
    room.isConnected = false;
    speechTranslate.stopStreamCapture(roomId);
    io.to(roomId).emit("tiktokStatus", { status: "disconnected", uniqueId: cleanId });
  });

  await conn.connect();
  room.connection  = conn;
  room.isConnected = true;
  room.state.tiktokUniqueId = cleanId;
  saveRoomConfig(roomId);
  io.to(roomId).emit("tiktokStatus", { status: "connected", uniqueId: cleanId });

  if (room.state.speechEnabled && room.state.speechApiKey) {
    const streamUrl = speechTranslate.extractFromRoomInfo(conn.roomInfo);
    if (streamUrl) {
      speechTranslate.startStreamCapture(roomId, streamUrl, io, () => room.state);
    } else {
      speechTranslate.startStreamCaptureByUsername(roomId, cleanId, io, () => room.state);
    }
  }

  return cleanId;
}

// ── Admin routes ──────────────────────────────────────────────────────────

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public/admin.html")));

app.get("/admin/rooms", (req, res) => {
  const list = [...rooms.entries()].map(([id, room]) => ({
    id,
    tiktokUniqueId: room.state.tiktokUniqueId || "",
    isConnected:    room.isConnected
  }));
  res.json(list);
});

app.post("/admin/rooms/create", (req, res) => {
  const roomId = crypto.randomBytes(3).toString("hex"); // 6-char hex
  createRoom(roomId);
  saveRoomConfig(roomId);
  res.json({ roomId });
});

app.delete("/admin/rooms/:roomId", (req, res) => {
  const { roomId } = req.params;
  disconnectRoom(roomId);
  rooms.delete(roomId);
  const cfgPath = getRoomConfigPath(roomId);
  if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  res.json({ success: true });
});

// ── Room-scoped routes helper ─────────────────────────────────────────────

function requireRoom(req, res) {
  const room = getRoom(req.params.roomId);
  if (!room) { res.status(404).json({ success: false, message: "Room not found" }); return null; }
  return room;
}

// ── TikTok routes ─────────────────────────────────────────────────────────

app.post("/room/:roomId/tiktok/connect", async (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  try {
    const id = await connectRoom(req.params.roomId, (req.body || {}).uniqueId);
    res.json({ success: true, uniqueId: id });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post("/room/:roomId/tiktok/disconnect", async (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  await disconnectRoom(req.params.roomId);
  io.to(req.params.roomId).emit("tiktokStatus", { status: "disconnected", uniqueId: room.state.tiktokUniqueId || "" });
  res.json({ success: true });
});

// ── Jar control routes ────────────────────────────────────────────────────

app.post("/room/:roomId/jar-control/rain", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  for (let i = 0; i < 20; i++) {
    setTimeout(() => io.to(req.params.roomId).emit("giftDrop", { username: "Test", giftName: "Test Gift", imgPath: "" }), i * 80);
  }
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/reset", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  io.to(req.params.roomId).emit("jarReset");
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/effect-set", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { control, value } = req.body || {};
  const v = Number(value);
  if (!control || !Number.isFinite(v)) return res.status(400).json({ success: false, message: "invalid payload" });

  const s = room.state;
  if (control === "allX")        s.allX        = v;
  if (control === "allY")        s.allY        = v;
  if (control === "allScale")    s.allScale    = v;
  if (control === "jarWidth")    s.jarWidth    = v;
  if (control === "jarHeight")   s.jarHeight   = v;
  if (control === "jarX")        s.jarBaseX    = v;
  if (control === "jarY")        s.jarBaseY    = v;
  if (control === "giftWidth")   s.giftWidth   = v;
  if (control === "giftHeight")  s.giftHeight  = v;
  if (control === "giftX")       s.giftBaseX   = v;
  if (control === "giftY")       s.giftBaseY   = v;
  if (control === "giftSize")    s.giftSize    = v;
  if (control === "giftBounce")  s.giftBounce  = v;
  if (control === "giftFriction") s.giftFriction = v;
  if (control === "mouthOpacity") s.mouthOpacity = v;
  if (control === "mouthX")      s.mouthX      = v;
  if (control === "mouthY")      s.mouthY      = v;
  if (control === "mouthScale")  s.mouthScale  = v;

  if (["allX","allY","jarX","jarY","giftX","giftY"].includes(control)) applyAllOffset(room);

  const roomId   = req.params.roomId;
  const emitVal  = control === "jarX"  ? s.jarX
                 : control === "jarY"  ? s.jarY
                 : control === "giftX" ? s.giftX
                 : control === "giftY" ? s.giftY : v;
  io.to(roomId).emit("jarEffectSet", { control, value: emitVal });

  if (control === "allX" || control === "allY") {
    io.to(roomId).emit("jarEffectSet", { control: "jarX",  value: s.jarX  });
    io.to(roomId).emit("jarEffectSet", { control: "jarY",  value: s.jarY  });
    io.to(roomId).emit("jarEffectSet", { control: "giftX", value: s.giftX });
    io.to(roomId).emit("jarEffectSet", { control: "giftY", value: s.giftY });
    s.stickers.forEach((st, index) => {
      io.to(roomId).emit("stickerTransformUpdated", { index, field: "x", value: st.x });
      io.to(roomId).emit("stickerTransformUpdated", { index, field: "y", value: st.y });
    });
  }

  saveRoomConfig(roomId);
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/effect-reset", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  loadRoomConfig(room);
  applyAllOffset(room);
  io.to(req.params.roomId).emit("jarStateInit", { ...room.state, isConnected: room.isConnected });
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/upload-image", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== "string") return res.status(400).json({ success: false, message: "imageUrl required" });
  room.state.jarImageUrl = imageUrl;
  io.to(req.params.roomId).emit("jarImageUpdated", { imageUrl });
  saveRoomConfig(req.params.roomId);
  res.json({ success: true, imageUrl });
});

app.post("/room/:roomId/jar-control/sticker-image", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { index, imageUrl } = req.body || {};
  const idx = getStickerIndex(index, room);
  if (idx < 0) return res.status(400).json({ success: false, message: "invalid sticker index" });
  if (typeof imageUrl !== "string") return res.status(400).json({ success: false, message: "imageUrl required" });
  room.state.stickers[idx].imageUrl = imageUrl || null;
  io.to(req.params.roomId).emit("stickerImageUpdated", { index: idx, imageUrl: room.state.stickers[idx].imageUrl });
  saveRoomConfig(req.params.roomId);
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/sticker-set", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { index, field, value } = req.body || {};
  const idx = getStickerIndex(index, room);
  const v   = Number(value);
  if (idx < 0 || !["x","y","width","height"].includes(field) || !Number.isFinite(v))
    return res.status(400).json({ success: false, message: "invalid payload" });

  if (field === "x")      room.state.stickers[idx].baseX  = v;
  if (field === "y")      room.state.stickers[idx].baseY  = v;
  if (field === "width")  room.state.stickers[idx].width  = v;
  if (field === "height") room.state.stickers[idx].height = v;
  applyAllOffset(room);

  const st = room.state.stickers[idx];
  const emitVal = field === "x" ? st.x : field === "y" ? st.y : v;
  io.to(req.params.roomId).emit("stickerTransformUpdated", { index: idx, field, value: emitVal });
  saveRoomConfig(req.params.roomId);
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/sticker-reset", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const idx = getStickerIndex((req.body || {}).index, room);
  if (idx < 0) return res.status(400).json({ success: false, message: "invalid sticker index" });
  room.state.stickers[idx] = { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0, x: room.state.allX, y: room.state.allY };
  io.to(req.params.roomId).emit("stickerReset", { index: idx, sticker: room.state.stickers[idx] });
  saveRoomConfig(req.params.roomId);
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/save-config", (req, res) => {
  if (!requireRoom(req, res)) return;
  try { saveRoomConfig(req.params.roomId); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/room/:roomId/jar-control/state", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  res.json({ ...room.state, isConnected: room.isConnected });
});

// ── Module routes ─────────────────────────────────────────────────────────

viewComment.register(app, io, getRoom, saveRoomConfig);
googleRead.register(app, io, getRoom, saveRoomConfig);
translateOverlay.register(app, io, getRoom, saveRoomConfig);
speechTranslate.register(app, io, getRoom, saveRoomConfig);

// ── Socket.IO ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  socket.on("joinRoom", (roomId) => {
    socket.join(roomId);
    const room = getRoom(roomId);
    if (!room) return;
    socket.emit("jarStateInit", { ...room.state, isConnected: room.isConnected });
    socket.emit("tiktokStatus", {
      status:   room.isConnected ? "connected" : "disconnected",
      uniqueId: room.state.tiktokUniqueId || ""
    });
  });

  socket.on("jarStateRequest", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = getRoom(roomId);
      if (room) socket.emit("jarStateInit", { ...room.state, isConnected: room.isConnected });
    }
  });
});

server.listen(3000, () => console.log("Server chạy tại http://localhost:3000"));
