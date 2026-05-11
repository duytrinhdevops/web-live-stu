const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");
const viewComment       = require("./modules/view_comment");
const googleRead        = require("./modules/google_read");
const translateOverlay  = require("./modules/translate_overlay");
const speechTranslate   = require("./modules/speech_translate");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CONFIG_PATH = path.join(__dirname, "config.json");

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

function defaultState() {
  return {
    tiktokUniqueId: "",
    allX: 0,
    allY: 0,
    allScale: 1,
    jarWidth: 1,
    jarHeight: 1,
    jarBaseX: 0,
    jarBaseY: 0,
    jarImageUrl: null,
    giftWidth: 1,
    giftHeight: 1,
    giftBaseX: 0,
    giftBaseY: 0,
    giftSize: 1,
    giftBounce: 0.02,
    giftFriction: 0.6,
    mouthOpacity: 0,
    mouthX: 0,
    mouthY: 0,
    mouthScale: 1,
    ...viewComment.DEFAULT_STATE,
    ...googleRead.DEFAULT_STATE,
    ...translateOverlay.DEFAULT_STATE,
    ...speechTranslate.DEFAULT_STATE,
    stickers: [
      { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 },
      { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 },
      { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 },
      { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 },
      { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 }
    ]
  };
}

let jarState = defaultState();

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const fallback = defaultState();
    jarState = {
      ...fallback,
      ...parsed,
      stickers: Array.isArray(parsed.stickers) && parsed.stickers.length === 5
        ? parsed.stickers.map(s => ({ imageUrl: null, width: 1, height: 1, x: 0, y: 0, ...s }))
        : fallback.stickers
    };
  } catch (err) {
    console.log("Load config failed:", err.message);
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(jarState, null, 2), "utf8");
}

loadConfig();
applyAllOffset();

function getStickerIndex(value) {
  const idx = Number(value);
  if (!Number.isInteger(idx) || idx < 0 || idx >= jarState.stickers.length) return -1;
  return idx;
}

function emitStatus(status, extra = {}) {
  io.emit("tiktokStatus", { status, ...extra });
}

function applyAllOffset() {
  const allX = Number(jarState.allX || 0);
  const allY = Number(jarState.allY || 0);

  jarState.jarX = jarState.jarBaseX + allX;
  jarState.jarY = jarState.jarBaseY + allY;
  jarState.giftX = jarState.giftBaseX + allX;
  jarState.giftY = jarState.giftBaseY + allY;

  for (const sticker of jarState.stickers) {
    sticker.x = (sticker.baseX || 0) + allX;
    sticker.y = (sticker.baseY || 0) + allY;
  }
}

let currentConnection = null;
let isConnected = false;

async function disconnectTikTokInternal() {
  if (!currentConnection) return;
  speechTranslate.stopStreamCapture();
  try {
    if (typeof currentConnection.disconnect === "function") {
      await currentConnection.disconnect();
    }
  } catch (err) {
    // ignore
  }
  currentConnection = null;
  isConnected = false;
}

async function connectTikTokById(uniqueId) {
  const cleanId = String(uniqueId || "").trim();
  if (!cleanId) {
    throw new Error("ID TikTok không hợp lệ");
  }

  emitStatus("connecting", { uniqueId: cleanId });
  await disconnectTikTokInternal();

  const conn = new WebcastPushConnection(cleanId, {
    processInitialData: false,
    enableWebsocketUpgrade: false,
    requestPollingIntervalMs: 1000
  });

  conn.on("gift", data => {
    const gift = data.giftName || "quà";
    const count = data.repeatCount || 1;
    const user =
      data.nickname ||
      data.uniqueId ||
      data.userDetails?.nickname ||
      data.userDetails?.uniqueId ||
      "Unknown";

    const giftImageUrl =
      data.giftPictureUrl ||
      (data.gift && data.gift.image && data.gift.image.url_list && data.gift.image.url_list[0]) ||
      "";

    for (let i = 0; i < count; i++) {
      io.emit("giftDrop", {
        username: user,
        giftName: gift,
        imgPath: giftImageUrl
      });
    }
  });

  viewComment.attachChatListener(conn, io);
  googleRead.attachChatListener(conn, io, () => jarState);
  translateOverlay.attachChatListener(conn, io, () => jarState);

  conn.on("streamEnd", () => {
    isConnected = false;
    speechTranslate.stopStreamCapture();
    emitStatus("live_ended", { uniqueId: cleanId });
  });

  conn.on("disconnected", () => {
    isConnected = false;
    speechTranslate.stopStreamCapture();
    emitStatus("disconnected", { uniqueId: cleanId });
  });

  try {
    await conn.connect();
    currentConnection = conn;
    isConnected = true;

    jarState.tiktokUniqueId = cleanId;
    saveConfig();
    emitStatus("connected", { uniqueId: cleanId });

    // Auto-start stream audio capture if speech is enabled
    if (jarState.speechEnabled && jarState.speechApiKey) {
      const streamUrl = speechTranslate.extractFromRoomInfo(conn.roomInfo);
      if (streamUrl) {
        speechTranslate.startStreamCapture(streamUrl, io, () => jarState);
      } else {
        console.log("[speech] Stream URL not in roomInfo, falling back to yt-dlp");
        speechTranslate.startStreamCaptureByUsername(cleanId, io, () => jarState);
      }
    }

    return cleanId;
  } catch (err) {
    await disconnectTikTokInternal();
    emitStatus("error", { uniqueId: cleanId, message: err.message });
    throw err;
  }
}

app.post("/tiktok/connect", async (req, res) => {
  const { uniqueId } = req.body || {};
  try {
    const id = await connectTikTokById(uniqueId);
    res.json({ success: true, uniqueId: id });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || "Connect failed" });
  }
});

app.post("/tiktok/disconnect", async (req, res) => {
  await disconnectTikTokInternal();
  emitStatus("disconnected", { uniqueId: jarState.tiktokUniqueId || "" });
  res.json({ success: true });
});

app.post("/jar-control/rain", (req, res) => {
  for (let i = 0; i < 20; i++) {
    setTimeout(() => {
      io.emit("giftDrop", {
        username: "Test User",
        giftName: "Test Gift",
        imgPath: ""
      });
    }, i * 80);
  }
  res.json({ success: true });
});

app.post("/jar-control/reset", (req, res) => {
  io.emit("jarReset");
  res.json({ success: true });
});

app.post("/jar-control/effect-set", (req, res) => {
  const { control, value } = req.body || {};
  const v = Number(value);
  if (!control || !Number.isFinite(v)) {
    return res.status(400).json({ success: false, message: "invalid payload" });
  }

  if (control === "allX")     jarState.allX     = v;
  if (control === "allY")     jarState.allY     = v;
  if (control === "allScale") jarState.allScale = v;
  if (control === "jarWidth") jarState.jarWidth = v;
  if (control === "jarHeight") jarState.jarHeight = v;
  if (control === "jarX") jarState.jarBaseX = v;
  if (control === "jarY") jarState.jarBaseY = v;
  if (control === "giftWidth")    jarState.giftWidth    = v;
  if (control === "giftHeight")   jarState.giftHeight   = v;
  if (control === "giftX")        jarState.giftBaseX    = v;
  if (control === "giftY")        jarState.giftBaseY    = v;
  if (control === "giftSize")      jarState.giftSize     = v;
  if (control === "giftBounce")    jarState.giftBounce   = v;
  if (control === "giftFriction")  jarState.giftFriction = v;
  if (control === "mouthOpacity")  jarState.mouthOpacity = v;
  if (control === "mouthX")        jarState.mouthX       = v;
  if (control === "mouthY")        jarState.mouthY       = v;
  if (control === "mouthScale")    jarState.mouthScale   = v;

  if (control === "allX" || control === "allY") {
    applyAllOffset();
  } else if (control === "jarX" || control === "jarY" || control === "giftX" || control === "giftY") {
    applyAllOffset();
  }

  const emitValue = control === "jarX"  ? jarState.jarX
                  : control === "jarY"  ? jarState.jarY
                  : control === "giftX" ? jarState.giftX
                  : control === "giftY" ? jarState.giftY
                  : v;
  io.emit("jarEffectSet", { control, value: emitValue });

  if (control === "allX" || control === "allY") {
    io.emit("jarEffectSet", { control: "jarX", value: jarState.jarX });
    io.emit("jarEffectSet", { control: "jarY", value: jarState.jarY });
    io.emit("jarEffectSet", { control: "giftX", value: jarState.giftX });
    io.emit("jarEffectSet", { control: "giftY", value: jarState.giftY });
    jarState.stickers.forEach((s, index) => {
      io.emit("stickerTransformUpdated", { index, field: "x", value: s.x });
      io.emit("stickerTransformUpdated", { index, field: "y", value: s.y });
    });
  }

  saveConfig();
  res.json({ success: true });
});

app.post("/jar-control/effect-reset", (req, res) => {
  // Khôi phục về config đã lưu lần cuối (nếu chưa có file thì về default)
  if (fs.existsSync(CONFIG_PATH)) {
    loadConfig();
  } else {
    jarState = defaultState();
  }
  applyAllOffset();
  io.emit("jarStateInit", { ...jarState, isConnected });
  res.json({ success: true });
});

app.post("/jar-control/upload-image", (req, res) => {
  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).json({ success: false, message: "imageUrl required" });
  }

  jarState.jarImageUrl = imageUrl;
  io.emit("jarImageUpdated", { imageUrl });
  saveConfig();
  res.json({ success: true, imageUrl });
});

app.post("/jar-control/sticker-image", (req, res) => {
  const { index, imageUrl } = req.body || {};
  const idx = getStickerIndex(index);
  if (idx < 0) return res.status(400).json({ success: false, message: "invalid sticker index" });
  if (typeof imageUrl !== "string") return res.status(400).json({ success: false, message: "imageUrl required" });

  jarState.stickers[idx].imageUrl = imageUrl || null;
  io.emit("stickerImageUpdated", { index: idx, imageUrl: jarState.stickers[idx].imageUrl });
  saveConfig();
  res.json({ success: true, sticker: jarState.stickers[idx] });
});

app.post("/jar-control/sticker-set", (req, res) => {
  const { index, field, value } = req.body || {};
  const idx = getStickerIndex(index);
  const v = Number(value);
  const allowed = new Set(["x", "y", "width", "height"]);

  if (idx < 0 || !allowed.has(field) || !Number.isFinite(v)) {
    return res.status(400).json({ success: false, message: "invalid payload" });
  }

  if (field === "x") jarState.stickers[idx].baseX = v;
  if (field === "y") jarState.stickers[idx].baseY = v;
  if (field === "width") jarState.stickers[idx].width = v;
  if (field === "height") jarState.stickers[idx].height = v;

  applyAllOffset();

  if (field === "x") io.emit("stickerTransformUpdated", { index: idx, field: "x", value: jarState.stickers[idx].x });
  if (field === "y") io.emit("stickerTransformUpdated", { index: idx, field: "y", value: jarState.stickers[idx].y });
  if (field === "width") io.emit("stickerTransformUpdated", { index: idx, field: "width", value: jarState.stickers[idx].width });
  if (field === "height") io.emit("stickerTransformUpdated", { index: idx, field: "height", value: jarState.stickers[idx].height });

  saveConfig();
  res.json({ success: true, sticker: jarState.stickers[idx] });
});

app.post("/jar-control/sticker-reset", (req, res) => {
  const { index } = req.body || {};
  const idx = getStickerIndex(index);
  if (idx < 0) return res.status(400).json({ success: false, message: "invalid sticker index" });

  jarState.stickers[idx] = { imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0, x: jarState.allX, y: jarState.allY };
  io.emit("stickerReset", { index: idx, sticker: jarState.stickers[idx] });
  saveConfig();
  res.json({ success: true, sticker: jarState.stickers[idx] });
});

app.post("/jar-control/save-config", (req, res) => {
  try {
    saveConfig();
    res.json({ success: true, path: "config.json" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/jar-control/state", (req, res) => {
  res.json({ ...jarState, isConnected });
});

viewComment.register(app, io, () => jarState, saveConfig);
googleRead.register(app, io, () => jarState, saveConfig);
translateOverlay.register(app, io, () => jarState, saveConfig);
speechTranslate.register(app, io, () => jarState, saveConfig);

io.on("connection", (socket) => {
  socket.emit("jarStateInit", { ...jarState, isConnected });

  socket.emit("tiktokStatus", {
    status: isConnected ? "connected" : "disconnected",
    uniqueId: jarState.tiktokUniqueId || ""
  });

  socket.on("jarStateRequest", () => {
    socket.emit("jarStateInit", { ...jarState, isConnected });
  });
});

server.listen(3000, () => {
  console.log("Server chạy tại http://localhost:3000");
});
