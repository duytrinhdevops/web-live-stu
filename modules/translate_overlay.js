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
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
      }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(raw);
          const translated = json[0].map(seg => seg[0] || "").join("").trim();
          resolve(translated);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.setTimeout(6000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function register(app, io, getState, saveConfig) {
  app.get("/translate.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/translate.html"));
  });

  app.post("/translate-control/set", (req, res) => {
    const state = getState();
    const { enabled, targetLang } = req.body || {};
    if (enabled    !== undefined) state.translateEnabled    = Boolean(enabled);
    if (targetLang !== undefined) state.translateTargetLang = String(targetLang);
    io.emit("translateConfig", {
      translateEnabled:    state.translateEnabled,
      translateTargetLang: state.translateTargetLang
    });
    saveConfig();
    res.json({ success: true });
  });

  app.post("/translate-control/clear", (req, res) => {
    io.emit("translateClear");
    res.json({ success: true });
  });
}

function attachChatListener(conn, io, getState) {
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

    const targetLang = state.translateTargetLang || "en";

    fetchTranslation(message, targetLang)
      .then(translated => {
        if (!translated || translated.toLowerCase() === message.toLowerCase()) return;
        io.emit("translateDrop", { username: user, original: message, translated });
      })
      .catch(() => {});
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };
