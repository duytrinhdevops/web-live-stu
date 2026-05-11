const https = require("https");

// Giá trị mặc định — merge vào defaultState() của server
const DEFAULT_STATE = {
  ttsEnabled: false,
  ttsVolume: 80,
  ttsRate: 100,
  ttsLang: "vi",
  ttsSkipWords: [],
  ttsReplacements: []
};

function processText(text, state) {
  let t = text;

  const replacements = Array.isArray(state.ttsReplacements) ? state.ttsReplacements : [];
  for (const r of replacements) {
    if (!r.from) continue;
    const escaped = r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(escaped, "gi"), r.to || "");
  }

  const skipWords = Array.isArray(state.ttsSkipWords) ? state.ttsSkipWords : [];
  for (const w of skipWords) {
    if (!w) continue;
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(escaped, "gi"), "");
  }

  return t.replace(/\s+/g, " ").trim();
}

// Đăng ký routes
function register(app, io, getState, saveConfig) {

  // Proxy Google Translate TTS để tránh CORS từ browser
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
        "Referer": "https://translate.google.com/"
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

  // Cập nhật cài đặt TTS
  app.post("/tts-control/set", (req, res) => {
    const state = getState();
    const { enabled, volume, rate, lang } = req.body || {};
    if (enabled !== undefined)                           state.ttsEnabled      = Boolean(enabled);
    if (volume !== undefined && Number.isFinite(+volume)) state.ttsVolume      = Number(volume);
    if (rate   !== undefined && Number.isFinite(+rate))   state.ttsRate        = Number(rate);
    if (lang)                                             state.ttsLang        = String(lang);
    if (Array.isArray(req.body.skipWords))               state.ttsSkipWords   = req.body.skipWords;
    if (Array.isArray(req.body.replacements))            state.ttsReplacements = req.body.replacements;

    io.emit("ttsConfig", {
      ttsEnabled:      state.ttsEnabled,
      ttsVolume:       state.ttsVolume,
      ttsRate:         state.ttsRate,
      ttsLang:         state.ttsLang,
      ttsSkipWords:    state.ttsSkipWords,
      ttsReplacements: state.ttsReplacements
    });
    saveConfig();
    res.json({ success: true });
  });
}

// Gắn vào TikTok connection — emit ttsSpeak khi có comment mới và TTS đang bật
function attachChatListener(conn, io, getState) {
  conn.on("chat", data => {
    const raw = (data.comment || "").trim();
    if (!raw) return;
    const state = getState();
    if (!state.ttsEnabled) return;

    const text = processText(raw, state);
    if (!text) return;

    io.emit("ttsSpeak", {
      text,
      lang:   state.ttsLang   || "vi",
      volume: state.ttsVolume ?? 80,
      rate:   state.ttsRate   ?? 100
    });
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };
