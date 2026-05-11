const https = require("https");
const path  = require("path");

const DEFAULT_STATE = {
  translateEnabled:    false,
  translateTargetLang: "en"
};

function fetchTranslation(text, targetLang) {
  return new Promise((resolve, reject) => {
    const url =
      "https://translate.googleapis.com/translate_a/single" +
      `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const req = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)[0].map(s => s[0] || "").join("").trim()); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function register(app, io, getRoom, saveRoomConfig) {
  app.get("/translate.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/translate.html"));
  });

  app.post("/room/:roomId/translate-control/set", (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });
    const { enabled, targetLang } = req.body || {};
    if (enabled    !== undefined) room.state.translateEnabled    = Boolean(enabled);
    if (targetLang !== undefined) room.state.translateTargetLang = String(targetLang);
    io.to(req.params.roomId).emit("translateConfig", {
      translateEnabled:    room.state.translateEnabled,
      translateTargetLang: room.state.translateTargetLang
    });
    saveRoomConfig(req.params.roomId);
    res.json({ success: true });
  });

  app.post("/room/:roomId/translate-control/clear", (req, res) => {
    if (!getRoom(req.params.roomId)) return res.status(404).json({ success: false });
    io.to(req.params.roomId).emit("translateClear");
    res.json({ success: true });
  });
}

function attachChatListener(conn, roomId, io, getState) {
  conn.on("chat", data => {
    const message = (data.comment || "").trim();
    if (!message) return;
    const state = getState();
    if (!state.translateEnabled) return;
    const user =
      data.nickname ||
      data.uniqueId ||
      data.userDetails?.nickname ||
      data.userDetails?.uniqueId ||
      "Unknown";
    fetchTranslation(message, state.translateTargetLang || "en")
      .then(translated => {
        if (!translated || translated.toLowerCase() === message.toLowerCase()) return;
        io.to(roomId).emit("translateDrop", { username: user, original: message, translated });
      })
      .catch(() => {});
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };
