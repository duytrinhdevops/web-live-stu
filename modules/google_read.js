const https = require("https");

const DEFAULT_STATE = {
  ttsEnabled:      false,
  ttsVolume:       80,
  ttsRate:         100,
  ttsLang:         "vi",
  ttsSkipWords:    [],
  ttsReplacements: []
};

// Emoji / symbol unicode ranges (u flag required for \u{XXXXX} syntax)
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20D0}-\u{20FF}]/gu;

// Strip the @ but keep the username so TTS reads the name after the tag.
// ASCII-only match stops before Vietnamese text even without a space separator.
const MENTION_RE = /@([a-zA-Z0-9_.]+)/g;

// Build regex for exotic/non-breaking whitespace chars using code points so the
// source file stays ASCII and avoids invisible char encoding issues.
// Covers: U+00A0 NBSP, U+1680 Ogham, U+2000-U+200A various, U+202F narrow NBSP,
//         U+205F math space, U+3000 ideographic space.
function _cp(n) { return String.fromCharCode(n); }
function _range(a, b) { return _cp(a) + "-" + _cp(b); }
const EXOTIC_SPACE_RE = new RegExp(
  "[" +
  _cp(0x00A0) +         // NO-BREAK SPACE
  _cp(0x1680) +         // OGHAM SPACE MARK
  _range(0x2000, 0x200A) + // EN QUAD ... HAIR SPACE
  _cp(0x202F) +         // NARROW NO-BREAK SPACE
  _cp(0x205F) +         // MEDIUM MATHEMATICAL SPACE
  _cp(0x3000) +         // IDEOGRAPHIC SPACE
  "]",
  "g"
);

// Zero-width and invisible control chars that cause TTS glitches.
// Covers: U+200B-U+200F ZW/directional, U+2028-U+202E separators/bidi,
//         U+2060-U+206F word joiners, U+FEFF BOM.
const INVISIBLE_RE = new RegExp(
  "[" +
  _range(0x200B, 0x200F) + // ZERO WIDTH SPACE ... RIGHT-TO-LEFT MARK
  _range(0x2028, 0x202E) + // LINE SEPARATOR ... RIGHT-TO-LEFT OVERRIDE
  _range(0x2060, 0x206F) + // WORD JOINER ... INVISIBLE PLUS SIGN
  _cp(0xFEFF) +             // ZERO WIDTH NO-BREAK SPACE / BOM
  "]",
  "g"
);

function processText(text, state) {
  let t = text;

  // NFC normalization: Vietnamese diacritics stored as NFD (base char + separate
  // combining mark codepoint) cause Google TTS to voice the mark as an extra
  // vowel -- e.g. NFD "ca`" -> TTS hears "ca a". NFC fuses them into one char.
  t = t.normalize("NFC");

  // Normalise exotic whitespace so @mention regex stops at the right boundary
  t = t.replace(EXOTIC_SPACE_RE, " ");

  // Remove invisible chars that produce unexpected TTS artefacts
  t = t.replace(INVISIBLE_RE, "");

  // Strip content that produces garbled speech
  t = t.replace(/https?:\/\/\S+/gi, "");  // full URLs
  t = t.replace(/www\.\S+/gi,        ""); // bare www. links
  t = t.replace(MENTION_RE,          "$1"); // strip @ but keep the username
  t = t.replace(/#\S+/g,             ""); // #hashtags
  t = t.replace(EMOJI_RE,            ""); // emoji / symbols
  t = t.replace(/(.)\1{4,}/gu, "$1$1");  // collapse spam chars (aaaaa -> aa)

  // User-defined replacements, then skip-words.
  // (?<![^\s]) / (?![^\s]) ensures the pattern only matches when surrounded by
  // whitespace or string edges, so "e"→"em" won't fire inside "che", "xem", etc.
  for (const r of (state.ttsReplacements || [])) {
    if (!r.from) continue;
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp("(?<![^\\s])" + esc + "(?![^\\s])", "gi"), r.to || "");
  }
  for (const w of (state.ttsSkipWords || [])) {
    if (!w) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp("(?<![^\\s])" + esc + "(?![^\\s])", "gi"), "");
  }

  return t.replace(/\s+/g, " ").trim();
}

function register(app, io, getRoom, saveRoomConfig) {
  // Global proxy -- no room needed
  app.get("/tts-audio", (req, res) => {
    const text = String(req.query.text || "").trim().slice(0, 200);
    const lang = String(req.query.lang || "vi");
    if (!text) return res.status(400).end();
    const ttsUrl =
      "https://translate.google.com/translate_tts" +
      "?ie=UTF-8&q=" + encodeURIComponent(text) +
      "&tl=" + encodeURIComponent(lang) +
      "&client=tw-ob&ttsspeed=1";
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
      lang:   state.ttsLang   ?? "vi",
      volume: state.ttsVolume ?? 80,
      rate:   state.ttsRate   ?? 100
    });
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };

