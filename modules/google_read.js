const https = require("https");

const DEFAULT_STATE = {
  ttsEnabled:      false,
  ttsVolume:       80,
  ttsRate:         100,
  ttsLang:         "vi",
  ttsSkipWords:    [],
  ttsReplacements: []
};

// Emoji ranges: emoticons, misc symbols, dingbats, supplemental symbols, etc.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20D0}-\u{20FF}]/gu;

function processText(text, state) {
  let t = text;

  // Strip content that causes garbled TTS output
  t = t.replace(/https?:\/\/\S+/gi, "");          // URLs
  t = t.replace(/www\.\S+/gi, "");                 // bare www. links
  t = t.replace(/@\S+/g, "");                      // @mentions
  t = t.replace(/#\S+/g, "");                      // #hashtags
  t = t.replace(EMOJI_RE, "");                     // emoji / symbols
  t = t.replace(/(.)\1{4,}/g, "$1$1");             // collapse spam (aaaaaaa → aa)

  // User-defined replacements then skip-words
  for (const r of (state.ttsReplacements || [])) {
    if (!r.from) continue;
    t = t.replace(new RegExp(r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), r.to || "");
  }
  for (const w of (state.ttsSkipWords || [])) {
    if (!w) continue;
    t = t.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
  }

  return t.replace(/\s+/g, " ").trim();
}

function register(app, io, getRoom, saveRoomConfig) {
  // Global proxy — no room needed
  app.get("/tts-audio", (req, res) => {
    const text = String(req.query.text || "").trim().slice(0, 200);
    const lang = String(req.query.lang || "vi");
    if (!text) return res.status(400).end();
    const ttsUrl =
      "https://translate.google.com/translate_tts" +
      `?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&client=tw-ob&ttsspeed=1`;
    const proxyReq = https.get(ttsUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer":    "https://translate.google.com/"
      }
    }, (ttsRes) => {
      if (ttsRes.statusCode !== 200) return res.status(ttsRes.statusCode || 500).end();
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      ttsRes.pipe(res);
    });
    proxyReq.setTimeout(8000, () => { proxyReq.destroy(); res.status(504).end(); });
    proxyReq.on("error", () => res.status(500).end());
  });

  app.post("/room/:roomId/tts-control/set", (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });
    const { enabled, volume, rate, lang } = req.body || {};
    if (enabled !== undefined)                              room.state.ttsEnabled      = Boolean(enabled);
    if (volume  !== undefined && Number.isFinite(+volume)) room.state.ttsVolume       = Number(volume);
    if (rate    !== undefined && Number.isFinite(+rate))   room.state.ttsRate         = Number(rate);
    if (lang)                                              room.state.ttsLang         = String(lang);
    if (Array.isArray(req.body.skipWords))                 room.state.ttsSkipWords    = req.body.skipWords;
    if (Array.isArray(req.body.replacements))              room.state.ttsReplacements = req.body.replacements;
    io.to(req.params.roomId).emit("ttsConfig", {
      ttsEnabled:      room.state.ttsEnabled,
      ttsVolume:       room.state.ttsVolume,
      ttsRate:         room.state.ttsRate,
      ttsLang:         room.state.ttsLang,
      ttsSkipWords:    room.state.ttsSkipWords,
      ttsReplacements: room.state.ttsReplacements
    });
    saveRoomConfig(req.params.roomId);
    res.json({ success: true });
  });
}

function attachChatListener(conn, roomId, io, getState) {
  conn.on("chat", data => {
    const raw = (data.comment || "").trim();
    if (!raw) return;
    const state = getState();
    if (!state || !state.ttsEnabled) return;
    const text = processText(raw, state);
    if (!text) return;
    io.to(roomId).emit("ttsSpeak", {
      text,
      lang:   state.ttsLang   || "vi",
      volume: state.ttsVolume ?? 80,
      rate:   state.ttsRate   ?? 100
    });
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };
