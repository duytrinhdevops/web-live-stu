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
const io     = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 }); // 10MB

const CONFIG_DIR  = path.join(__dirname, "configs");
const PRESET_DIR  = path.join(__dirname, "presets");
const USERS_FILE  = path.join(__dirname, "users.json");
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(CONFIG_DIR))  fs.mkdirSync(CONFIG_DIR,  { recursive: true });
if (!fs.existsSync(PRESET_DIR))  fs.mkdirSync(PRESET_DIR,  { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Auth ──────────────────────────────────────────────────────────────────

function hashPw(pw) {
  return crypto.createHash("sha256").update(String(pw)).digest("hex");
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const defaults = { duytrinh: { passwordHash: hashPw("duytrinh@"), role: "admin" } };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch { return {}; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const sessions     = new Map(); // token → { username, role, roomId }
const loginFails   = new Map(); // ip    → { count, blockedUntil }

const MAX_ATTEMPTS = 5;
const BLOCK_MS     = 60 * 1000; // 1 phút

const BEHIND_PROXY = process.env.BEHIND_PROXY === "1"; // set env nếu chạy sau nginx

function getClientIp(req) {
  if (BEHIND_PROXY) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket.remoteAddress || "";
  }
  return req.socket.remoteAddress || "";
}

function checkLoginRateLimit(ip) {
  const now  = Date.now();
  const rec  = loginFails.get(ip);
  if (rec && rec.blockedUntil > now) {
    const secs = Math.ceil((rec.blockedUntil - now) / 1000);
    return { blocked: true, secs };
  }
  return { blocked: false };
}

function recordLoginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, blockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) rec.blockedUntil = now + BLOCK_MS;
  loginFails.set(ip, rec);
}

function clearLoginFail(ip) {
  loginFails.delete(ip);
}

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 giờ

function createSession(username, role, roomId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, role, roomId: roomId || null, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

// Xoá session hết hạn mỗi 30 phút
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}, 30 * 60 * 1000);

function getSessionFromReq(req) {
  const raw = req.headers.cookie || "";
  const m   = raw.match(/session=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}

function setCookie(res, token) {
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; SameSite=Strict`);
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
}

function mwAdmin(req, res, next) {
  const s = getSessionFromReq(req);
  if (!s || s.role !== "admin") {
    if (req.method === "GET") return res.redirect("/login");
    return res.status(403).json({ error: "Forbidden" });
  }
  req.user = s; next();
}

function mwAuth(req, res, next) {
  const s = getSessionFromReq(req);
  if (!s) return res.status(401).json({ error: "Unauthorized" });
  req.user = s; next();
}

// User chỉ được truy cập room của mình; admin được tất cả
function mwRoomOwner(req, res, next) {
  const s = getSessionFromReq(req);
  if (!s) return res.status(401).json({ error: "Unauthorized" });
  if (s.role !== "admin" && s.roomId !== req.params.roomId) {
    return res.status(403).json({ error: "Bạn không có quyền truy cập room này" });
  }
  req.user = s; next();
}

// ── Express setup ─────────────────────────────────────────────────────────

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/room/:roomId", mwRoomOwner);

// Route gốc: home page cho khách, control panel cho user đã login
app.get("/", (req, res) => {
  if (req.query.room) {
    const s = getSessionFromReq(req);
    if (!s) return res.redirect("/login");
    return res.sendFile(path.join(__dirname, "public/index.html"));
  }
  res.sendFile(path.join(__dirname, "public/home.html"));
});

// ── Room state ────────────────────────────────────────────────────────────

function defaultState() {
  return {
    tiktokUniqueId: "",
    allX: 0, allY: 0, allScale: 1,
    jarWidth: 1, jarHeight: 1, jarBaseX: 0, jarBaseY: 0, jarImageUrl: null,
    giftWidth: 1, giftHeight: 1, giftBaseX: 0, giftBaseY: 0,
    giftSize: 1, giftBounce: 0.02, giftFriction: 0.6, giftSpacing: 0,
    mouthOpacity: 0, mouthX: 0, mouthY: 0, mouthScale: 1,
    // Alert
    alertMinDiamonds: 50, alertFollows: true, alertSound: true,
    // Goal
    goalTarget: 0, goalCurrent: 0, goalLabel: "Mục tiêu hôm nay",
    // Auto-reset
    autoResetMins: 0,
    // Comment filter
    commentBlacklist: [],
    ...viewComment.DEFAULT_STATE,
    ...googleRead.DEFAULT_STATE,
    ...translateOverlay.DEFAULT_STATE,
    ...speechTranslate.DEFAULT_STATE,
    stickers: Array(5).fill(null).map(() => ({ imageUrl: null, width: 1, height: 1, baseX: 0, baseY: 0 }))
  };
}

// Runtime data per room (không lưu config)
const roomRuntime = new Map(); // roomId → { leaderboard, giftHistory, viewers, likes, autoResetTimer }

function getRt(roomId) {
  if (!roomRuntime.has(roomId)) {
    roomRuntime.set(roomId, { leaderboard: new Map(), giftHistory: [], viewers: 0, likes: 0, autoResetTimer: null });
  }
  return roomRuntime.get(roomId);
}

function addToLeaderboard(roomId, username, diamonds) {
  const rt = getRt(roomId);
  const cur = rt.leaderboard.get(username) || { diamonds: 0, count: 0 };
  cur.diamonds += diamonds;
  cur.count++;
  rt.leaderboard.set(username, cur);
  const top = [...rt.leaderboard.entries()]
    .sort((a, b) => b[1].diamonds - a[1].diamonds)
    .slice(0, 10)
    .map(([name, d]) => ({ username: name, diamonds: d.diamonds, count: d.count }));
  io.to(roomId).emit("leaderboardUpdate", top);
}

function addGiftHistory(roomId, entry) {
  const rt = getRt(roomId);
  rt.giftHistory.unshift({ ...entry, time: Date.now() });
  if (rt.giftHistory.length > 50) rt.giftHistory.pop();
}

function scheduleAutoReset(roomId) {
  const rt  = getRt(roomId);
  const min = Number(getRoom(roomId)?.state.autoResetMins || 0);
  if (rt.autoResetTimer) { clearTimeout(rt.autoResetTimer); rt.autoResetTimer = null; }
  if (min <= 0) return;
  rt.autoResetTimer = setTimeout(() => {
    io.to(roomId).emit("jarReset");
    const lb = getRt(roomId);
    lb.leaderboard.clear();
    lb.giftHistory = [];
    io.to(roomId).emit("leaderboardUpdate", []);
    scheduleAutoReset(roomId); // reschedule
  }, min * 60 * 1000);
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
// Also re-save to persist any new defaultState fields into old config files
for (const file of fs.readdirSync(CONFIG_DIR)) {
  const m = file.match(/^config_([a-z0-9]+)\.json$/);
  if (m) { createRoom(m[1]); saveRoomConfig(m[1]); }
}

// Debounced save for goalCurrent (called on every gift)
const goalSaveTimers = new Map();
function debouncedSaveGoal(roomId) {
  if (goalSaveTimers.has(roomId)) clearTimeout(goalSaveTimers.get(roomId));
  goalSaveTimers.set(roomId, setTimeout(() => {
    goalSaveTimers.delete(roomId);
    saveRoomConfig(roomId);
  }, 30_000));
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
    if (room.connection !== conn) return;
    const gift     = data.giftName || "quà";
    const count    = data.repeatCount || 1;
    const user     = data.nickname || data.uniqueId || data.userDetails?.nickname || data.userDetails?.uniqueId || "Unknown";
    const imgPath  = data.giftPictureUrl || data.gift?.image?.url_list?.[0] || "";
    const diamonds = Number(data.diamondCount || data.gift?.diamond_count || 0);
    const total    = diamonds * count;

    addToLeaderboard(roomId, user, total);
    addGiftHistory(roomId, { username: user, giftName: gift, diamonds, count, imgPath });

    // Update goal
    const r2 = getRoom(roomId);
    if (r2 && r2.state.goalTarget > 0) {
      r2.state.goalCurrent += total;
      io.to(roomId).emit("goalUpdate", { current: r2.state.goalCurrent, target: r2.state.goalTarget, label: r2.state.goalLabel });
      debouncedSaveGoal(roomId);
    }

    // Alert for big gifts
    if (r2 && total >= (r2.state.alertMinDiamonds || 50)) {
      io.to(roomId).emit("alertDrop", { type: "gift", username: user, giftName: gift, diamonds: total, imgPath });
    }

    for (let i = 0; i < count; i++) {
      setTimeout(() => io.to(roomId).emit("giftDrop", { username: user, giftName: gift, imgPath, diamonds }), i * 100);
    }
  });

  conn.on("follow", data => {
    const r2 = getRoom(roomId);
    if (!r2 || !r2.state.alertFollows) return;
    const user = data.nickname || data.uniqueId || data.userDetails?.nickname || "Unknown";
    io.to(roomId).emit("alertDrop", { type: "follow", username: user });
  });

  conn.on("like", data => {
    const rt = getRt(roomId);
    rt.likes = data.totalLikeCount || (rt.likes + (data.likeCount || 0));
    io.to(roomId).emit("viewerUpdate", { viewers: rt.viewers, likes: rt.likes });
  });

  conn.on("roomUser", data => {
    const rt = getRt(roomId);
    if (data.viewerCount != null) rt.viewers = data.viewerCount;
    io.to(roomId).emit("viewerUpdate", { viewers: rt.viewers, likes: rt.likes });
  });

  // Returns state only if this conn is still the active connection
  const activeState = () => room.connection === conn ? room.state : null;

  viewComment.attachChatListener(conn, roomId, io, getRoom);
  googleRead.attachChatListener(conn, roomId, io, activeState);
  translateOverlay.attachChatListener(conn, roomId, io, activeState);

  conn.on("streamEnd", () => {
    if (room.connection !== conn) return;
    room.isConnected = false;
    speechTranslate.stopStreamCapture(roomId);
    io.to(roomId).emit("tiktokStatus", { status: "live_ended", uniqueId: cleanId });
  });

  conn.on("disconnected", () => {
    if (room.connection !== conn) return;
    room.isConnected = false;
    speechTranslate.stopStreamCapture(roomId);
    io.to(roomId).emit("tiktokStatus", { status: "disconnected", uniqueId: cleanId });
  });

  // Set room.connection early so any concurrent connectRoom call will disconnect this conn
  room.connection  = conn;
  room.isConnected = false;

  await conn.connect();
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

// ── Auth routes ───────────────────────────────────────────────────────────

app.get("/login", (req, res) => {
  const s = getSessionFromReq(req);
  if (s) return res.redirect(s.role === "admin" ? "/admin" : `/?room=${s.roomId}`);
  res.sendFile(path.join(__dirname, "public/login.html"));
});

app.post("/login", (req, res) => {
  const ip = getClientIp(req);
  const rl = checkLoginRateLimit(ip);
  if (rl.blocked) {
    return res.status(429).json({ error: `Quá nhiều lần thử. Vui lòng đợi ${rl.secs} giây.` });
  }

  const { username, password } = req.body || {};
  const users = loadUsers();
  const user  = users[String(username || "")];
  if (!user || user.passwordHash !== hashPw(password)) {
    recordLoginFail(ip);
    const rec  = loginFails.get(ip);
    const left = MAX_ATTEMPTS - rec.count;
    const msg  = left > 0
      ? `Sai tên đăng nhập hoặc mật khẩu (còn ${left} lần thử)`
      : `Quá nhiều lần thử. Vui lòng đợi ${BLOCK_MS / 1000} giây.`;
    return res.status(401).json({ error: msg });
  }

  clearLoginFail(ip);
  const token = createSession(username, user.role, user.roomId);
  setCookie(res, token);
  res.json({ success: true, role: user.role, redirect: user.role === "admin" ? "/admin" : `/?room=${user.roomId}` });
});

app.post("/logout", (req, res) => {
  const raw = req.headers.cookie || "";
  const m   = raw.match(/session=([a-f0-9]{64})/);
  if (m) sessions.delete(m[1]);
  clearCookie(res);
  res.redirect("/login");
});

app.get("/api/me", (req, res) => {
  const s = getSessionFromReq(req);
  if (!s) return res.status(401).json({ error: "Not authenticated" });
  res.json({ username: s.username, role: s.role, roomId: s.roomId });
});

// ── Admin routes ──────────────────────────────────────────────────────────

app.get("/admin", mwAdmin, (req, res) => res.sendFile(path.join(__dirname, "public/admin.html")));

app.get("/admin/rooms", mwAdmin, (req, res) => {
  const list = [...rooms.entries()].map(([id, room]) => ({
    id,
    tiktokUniqueId: room.state.tiktokUniqueId || "",
    isConnected:    room.isConnected
  }));
  res.json(list);
});

app.post("/admin/rooms/create", mwAdmin, (req, res) => {
  const roomId = crypto.randomBytes(3).toString("hex"); // 6-char hex
  createRoom(roomId);
  saveRoomConfig(roomId);
  res.json({ roomId });
});

app.delete("/admin/rooms/:roomId", mwAdmin, (req, res) => {
  const { roomId } = req.params;
  disconnectRoom(roomId);
  rooms.delete(roomId);
  const cfgPath = getRoomConfigPath(roomId);
  if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  res.json({ success: true });
});

app.get("/admin/rooms/:roomId/export", mwAdmin, (req, res) => {
  const { roomId } = req.params;
  const room = getRoom(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.setHeader("Content-Disposition", `attachment; filename="config_${roomId}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(room.state, null, 2));
});

app.post("/admin/rooms/:roomId/import", mwAdmin, express.json({ limit: "20mb" }), (req, res) => {
  const { roomId } = req.params;
  const room = getRoom(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object") return res.status(400).json({ error: "Invalid JSON" });
  Object.assign(room.state, incoming);
  applyAllOffset(room);
  saveRoomConfig(roomId);
  io.to(roomId).emit("jarStateInit", { ...publicState(room.state), isConnected: room.isConnected });
  res.json({ success: true });
});

// ── Preset routes ────────────────────────────────────────────────────────

app.get("/presets", mwAuth, (req, res) => {
  const files = fs.readdirSync(PRESET_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      let label = f.replace(/\.json$/, "");
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), "utf8"));
        if (data._name) label = data._name;
      } catch {}
      return { filename: f, label };
    });
  res.json(files);
});

app.get("/room/:roomId/export-config", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const roomId = req.params.roomId;
  res.setHeader("Content-Disposition", `attachment; filename="config_${roomId}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(room.state, null, 2));
});

app.post("/room/:roomId/import-config", express.json({ limit: "20mb" }), (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object") return res.status(400).json({ error: "Invalid JSON" });
  Object.assign(room.state, incoming);
  applyAllOffset(room);
  saveRoomConfig(req.params.roomId);
  io.to(req.params.roomId).emit("jarStateInit", { ...publicState(room.state), isConnected: room.isConnected });
  res.json({ success: true });
});

app.post("/room/:roomId/apply-preset", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { filename } = req.body || {};
  if (!filename || !/^[\w\-. ]+\.json$/.test(filename))
    return res.status(400).json({ error: "Invalid filename" });
  const filePath = path.join(PRESET_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Preset not found" });
  let preset;
  try { preset = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }
  delete preset._name;
  Object.assign(room.state, preset);
  applyAllOffset(room);
  saveRoomConfig(req.params.roomId);
  io.to(req.params.roomId).emit("jarStateInit", { ...publicState(room.state), isConnected: room.isConnected });
  res.json({ success: true });
});

app.post("/admin/presets/save", mwAdmin, (req, res) => {
  const { filename, label, roomId } = req.body || {};
  if (!filename || !/^[\w\-. ]+\.json$/.test(filename))
    return res.status(400).json({ error: "Invalid filename" });
  const room = roomId ? getRoom(roomId) : null;
  const state = room ? { ...room.state, _name: label || filename.replace(/\.json$/, "") }
                     : { _name: label || filename.replace(/\.json$/, "") };
  fs.writeFileSync(path.join(PRESET_DIR, filename), JSON.stringify(state, null, 2));
  res.json({ success: true });
});

app.delete("/admin/presets/:filename", mwAdmin, (req, res) => {
  const { filename } = req.params;
  if (!/^[\w\-. ]+\.json$/.test(filename)) return res.status(400).json({ error: "Invalid filename" });
  const filePath = path.join(PRESET_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

// ── User management routes ───────────────────────────────────────────────

app.get("/admin/users", mwAdmin, (req, res) => {
  const users = loadUsers();
  res.json(Object.entries(users).map(([username, u]) => ({
    username, role: u.role, roomId: u.roomId || null
  })));
});

app.post("/admin/users/create", mwAdmin, (req, res) => {
  const { username, password, role, roomId } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin" });
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: "Username chỉ dùng a-z, 0-9, _ (3-32 ký tự)" });
  if (String(password).length < 6) return res.status(400).json({ error: "Mật khẩu tối thiểu 6 ký tự" });
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: "Username đã tồn tại" });
  users[username] = { passwordHash: hashPw(password), role: role === "admin" ? "admin" : "user", roomId: roomId || null };
  saveUsers(users);
  res.json({ success: true });
});

app.post("/admin/users/:username/edit", mwAdmin, (req, res) => {
  const { username } = req.params;
  const { password, roomId } = req.body || {};
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: "Không tìm thấy user" });
  if (password) users[username].passwordHash = hashPw(password);
  if (roomId !== undefined) users[username].roomId = roomId || null;
  saveUsers(users);
  res.json({ success: true });
});

app.delete("/admin/users/:username", mwAdmin, (req, res) => {
  const { username } = req.params;
  if (username === req.user.username) return res.status(400).json({ error: "Không thể xoá tài khoản đang đăng nhập" });
  const users = loadUsers();
  delete users[username];
  saveUsers(users);
  res.json({ success: true });
});

// ── Room-scoped routes helper ─────────────────────────────────────────────

function requireRoom(req, res) {
  const room = getRoom(req.params.roomId);
  if (!room) { res.status(404).json({ success: false, message: "Room not found" }); return null; }
  return room;
}

// Xoá các field nhạy cảm trước khi gửi ra ngoài qua socket hoặc API
const SENSITIVE_FIELDS = ["speechApiKey"];
function publicState(state) {
  const s = { ...state };
  for (const f of SENSITIVE_FIELDS) delete s[f];
  return s;
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
    setTimeout(() => io.to(req.params.roomId).emit("giftDrop", { username: "Test", giftName: "Test Gift", imgPath: "", diamonds: 1 }), i * 80);
  }
  res.json({ success: true });
});

app.post("/room/:roomId/jar-control/drop", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const diamonds = Number(req.body?.diamonds || 1);
  const count    = Math.min(Number(req.body?.count || 1), 50);
  for (let i = 0; i < count; i++) {
    setTimeout(() => io.to(req.params.roomId).emit("giftDrop", { username: "Test", giftName: "Test Gift", imgPath: "", diamonds }), i * 130);
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
  if (control === "giftSpacing")  s.giftSpacing  = v;
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
  io.to(req.params.roomId).emit("jarStateInit", { ...publicState(room.state), isConnected: room.isConnected });
  res.json({ success: true });
});

// Lưu base64 data URL thành file vật lý, trả về URL path để phục vụ tĩnh
// Nếu value đã là URL path (không phải base64), giữ nguyên
function saveImageFile(base64DataUrl, filename) {
  if (!base64DataUrl || typeof base64DataUrl !== "string") return null;
  // Đã là URL path rồi (không phải data URL) — giữ nguyên
  if (!base64DataUrl.startsWith("data:")) return base64DataUrl;
  const m = base64DataUrl.match(/^data:image\/(\w+);base64,(.+)$/s);
  if (!m) return null;
  const ext  = m[1].toLowerCase().replace("jpeg", "jpg");
  const data = Buffer.from(m[2], "base64");
  const file = `${filename}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), data);
  return `/uploads/${file}`;
}

app.post("/room/:roomId/jar-control/upload-image", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== "string") return res.status(400).json({ success: false, message: "imageUrl required" });
  const servePath = saveImageFile(imageUrl, `jar_${req.params.roomId}`);
  if (!servePath) return res.status(400).json({ success: false, message: "Dữ liệu ảnh không hợp lệ" });
  room.state.jarImageUrl = servePath;
  io.to(req.params.roomId).emit("jarImageUpdated", { imageUrl: servePath });
  saveRoomConfig(req.params.roomId);
  res.json({ success: true, imageUrl: servePath });
});

app.post("/room/:roomId/jar-control/sticker-image", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { index, imageUrl } = req.body || {};
  const idx = getStickerIndex(index, room);
  if (idx < 0) return res.status(400).json({ success: false, message: "invalid sticker index" });
  if (typeof imageUrl !== "string") return res.status(400).json({ success: false, message: "imageUrl required" });
  const servePath = saveImageFile(imageUrl, `sticker_${req.params.roomId}_${idx}`);
  if (imageUrl && !servePath) return res.status(400).json({ success: false, message: "Dữ liệu ảnh không hợp lệ" });
  room.state.stickers[idx].imageUrl = servePath;
  io.to(req.params.roomId).emit("stickerImageUpdated", { index: idx, imageUrl: servePath });
  saveRoomConfig(req.params.roomId);
  res.json({ success: true, imageUrl: servePath });
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
  res.json({ ...publicState(room.state), isConnected: room.isConnected });
});

// ── Goal routes ───────────────────────────────────────────────────────────

app.post("/room/:roomId/goal/set", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { target, label } = req.body || {};
  if (target !== undefined) room.state.goalTarget = Math.max(0, Number(target) || 0);
  if (label  !== undefined) room.state.goalLabel  = String(label).slice(0, 100);
  saveRoomConfig(req.params.roomId);
  io.to(req.params.roomId).emit("goalUpdate", { current: room.state.goalCurrent, target: room.state.goalTarget, label: room.state.goalLabel });
  res.json({ success: true });
});

app.post("/room/:roomId/goal/add", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  room.state.goalCurrent = Math.max(0, room.state.goalCurrent + (Number(req.body?.amount) || 0));
  saveRoomConfig(req.params.roomId);
  io.to(req.params.roomId).emit("goalUpdate", { current: room.state.goalCurrent, target: room.state.goalTarget, label: room.state.goalLabel });
  res.json({ success: true });
});

app.post("/room/:roomId/goal/reset", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  room.state.goalCurrent = 0;
  saveRoomConfig(req.params.roomId);
  io.to(req.params.roomId).emit("goalUpdate", { current: 0, target: room.state.goalTarget, label: room.state.goalLabel });
  res.json({ success: true });
});

// ── Leaderboard routes ────────────────────────────────────────────────────

app.get("/room/:roomId/leaderboard", (req, res) => {
  if (!requireRoom(req, res)) return;
  const rt  = getRt(req.params.roomId);
  const top = [...rt.leaderboard.entries()]
    .sort((a, b) => b[1].diamonds - a[1].diamonds).slice(0, 10)
    .map(([name, d]) => ({ username: name, diamonds: d.diamonds, count: d.count }));
  res.json(top);
});

app.post("/room/:roomId/leaderboard/reset", (req, res) => {
  if (!requireRoom(req, res)) return;
  getRt(req.params.roomId).leaderboard.clear();
  io.to(req.params.roomId).emit("leaderboardUpdate", []);
  res.json({ success: true });
});

// ── Gift history ──────────────────────────────────────────────────────────

app.get("/room/:roomId/gift-history", (req, res) => {
  if (!requireRoom(req, res)) return;
  res.json(getRt(req.params.roomId).giftHistory);
});

// ── Comment filter ────────────────────────────────────────────────────────

app.post("/room/:roomId/comment-filter/set", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { blacklist } = req.body || {};
  if (Array.isArray(blacklist))
    room.state.commentBlacklist = blacklist.map(String).filter(Boolean).slice(0, 200);
  saveRoomConfig(req.params.roomId);
  res.json({ success: true });
});

// ── Alert settings ────────────────────────────────────────────────────────

app.post("/room/:roomId/alert/set", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  const { minDiamonds, follows, sound } = req.body || {};
  if (minDiamonds !== undefined) room.state.alertMinDiamonds = Math.max(0, Number(minDiamonds) || 0);
  if (follows     !== undefined) room.state.alertFollows     = Boolean(follows);
  if (sound       !== undefined) room.state.alertSound       = Boolean(sound);
  saveRoomConfig(req.params.roomId);
  res.json({ success: true });
});

// ── Auto-reset ────────────────────────────────────────────────────────────

app.post("/room/:roomId/auto-reset/set", (req, res) => {
  const room = requireRoom(req, res); if (!room) return;
  room.state.autoResetMins = Math.max(0, Number(req.body?.mins) || 0);
  saveRoomConfig(req.params.roomId);
  scheduleAutoReset(req.params.roomId);
  res.json({ success: true });
});

// ── Change own password ───────────────────────────────────────────────────

app.post("/api/change-password", mwAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: "Thiếu thông tin" });
  if (String(newPassword).length < 6) return res.status(400).json({ error: "Mật khẩu mới tối thiểu 6 ký tự" });
  const users = loadUsers();
  const user  = users[req.user.username];
  if (!user || user.passwordHash !== hashPw(oldPassword)) return res.status(401).json({ error: "Mật khẩu cũ không đúng" });
  user.passwordHash = hashPw(newPassword);
  saveUsers(users);
  res.json({ success: true });
});

// ── Admin stats ───────────────────────────────────────────────────────────

app.get("/admin/stats", mwAdmin, (req, res) => {
  const stats = [...rooms.entries()].map(([id, room]) => {
    const rt = getRt(id);
    const topEntry = rt.leaderboard.size > 0
      ? [...rt.leaderboard.entries()].sort((a, b) => b[1].diamonds - a[1].diamonds)[0]
      : null;
    return {
      id,
      tiktokUniqueId:   room.state.tiktokUniqueId || "",
      isConnected:      room.isConnected,
      viewers:          rt.viewers,
      likes:            rt.likes,
      giftHistoryCount: rt.giftHistory.length,
      topDonor:         topEntry ? { username: topEntry[0], diamonds: topEntry[1].diamonds } : null,
      goalTarget:       room.state.goalTarget,
      goalCurrent:      room.state.goalCurrent
    };
  });
  res.json(stats);
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
    socket.emit("jarStateInit", { ...publicState(room.state), isConnected: room.isConnected });
    socket.emit("tiktokStatus", {
      status:   room.isConnected ? "connected" : "disconnected",
      uniqueId: room.state.tiktokUniqueId || ""
    });
    const rt  = getRt(roomId);
    const top = [...rt.leaderboard.entries()]
      .sort((a, b) => b[1].diamonds - a[1].diamonds).slice(0, 10)
      .map(([name, d]) => ({ username: name, diamonds: d.diamonds, count: d.count }));
    socket.emit("leaderboardUpdate", top);
    socket.emit("viewerUpdate", { viewers: rt.viewers, likes: rt.likes });
    socket.emit("goalUpdate", { current: room.state.goalCurrent, target: room.state.goalTarget, label: room.state.goalLabel });
  });

  socket.on("jarStateRequest", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = getRoom(roomId);
      if (room) socket.emit("jarStateInit", { ...publicState(room.state), isConnected: room.isConnected });
    }
  });
});

server.listen(3000, () => console.log("Server chạy tại http://localhost:3000"));
