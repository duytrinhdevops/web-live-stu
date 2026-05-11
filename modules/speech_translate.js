const https  = require("https");
const path   = require("path");
const { spawn } = require("child_process");

const IS_WIN     = process.platform === "win32";
const BIN_DIR    = path.join(__dirname, "../ffmpeg");
const FFMPEG_EXE = IS_WIN ? path.join(BIN_DIR, "ffmpeg.exe")  : "ffmpeg";
const YTDLP_EXE  = IS_WIN ? path.join(BIN_DIR, "yt-dlp.exe")  : path.join(BIN_DIR, "yt-dlp");

const DEFAULT_STATE = {
  speechEnabled:    false,
  speechSourceLang: "vi",
  speechTargetLang: "en",
  speechProvider:   "groq",   // "groq" (free) | "openai"
  speechApiKey:     ""
};

const PROVIDERS = {
  groq:   { hostname: "api.groq.com",       path: "/openai/v1/audio/transcriptions", model: "whisper-large-v3-turbo" },
  openai: { hostname: "api.openai.com",      path: "/v1/audio/transcriptions",        model: "whisper-1" }
};

// ── Helpers ────────────────────────────────────────────────────────────────

const JUNK = new Set([
  "thank you", "thank you.", "thanks", "thanks for watching",
  "you", "bye", "bye.", "okay", "okay.", ".", "..", "...",
  "subtitles by the amara.org community"
]);
function isJunk(text) {
  const t = (text || "").trim();
  return t.length < 3 || JUNK.has(t.toLowerCase());
}

function buildWav(pcmData, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate   = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataLen    = pcmData.length;
  const hdr        = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + dataLen, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate, 28);
  hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitsPerSample, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(dataLen, 40);
  return Buffer.concat([hdr, pcmData]);
}


function fetchTranslation(text, targetLang) {
  return new Promise((resolve, reject) => {
    const url =
      "https://translate.googleapis.com/translate_a/single" +
      `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const req = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)[0].map(s => s[0] || "").join("").trim()); }
        catch(e) { reject(e); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); reject(new Error("translate timeout")); });
    req.on("error", reject);
  });
}

function callWhisper(wavBase64, sourceLang, apiKey, provider) {
  return new Promise((resolve, reject) => {
    const p        = PROVIDERS[provider] || PROVIDERS.groq;
    const audioBuf = Buffer.from(wavBase64, "base64");
    const boundary = "wb" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const CRLF     = "\r\n";

    const head = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"${CRLF}` +
      `Content-Type: audio/wav${CRLF}${CRLF}`
    );
    const tail = Buffer.from(
      `${CRLF}--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="model"${CRLF}${CRLF}${p.model}${CRLF}` +
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="language"${CRLF}${CRLF}${sourceLang}${CRLF}` +
      `--${boundary}--${CRLF}`
    );
    const body = Buffer.concat([head, audioBuf, tail]);

    const req = https.request({
      hostname: p.hostname,
      path:     p.path,
      method:   "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.text || "");
        } catch(e) {
          reject(new Error("STT parse: " + data.slice(0, 120)));
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("STT timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── FFmpeg stream capture ──────────────────────────────────────────────────

let ffmpegProc  = null;
let _io         = null;
let _getState   = null;

const SAMPLE_RATE  = 16000;
const CHUNK_SECS   = 6;
const CHUNK_BYTES  = SAMPLE_RATE * 2 * CHUNK_SECS; // 16-bit mono PCM

let pcmBuffer = Buffer.alloc(0);
let processing = false;

async function processWav(wavBase64) {
  if (processing) return; // don't stack concurrent Whisper calls
  processing = true;
  try {
    const state = _getState();
    if (!state.speechEnabled || !state.speechApiKey) return;

    const transcript = await callWhisper(wavBase64, state.speechSourceLang || "vi", state.speechApiKey, state.speechProvider || "groq");
    if (isJunk(transcript)) return;

    const sameLang  = state.speechTargetLang === state.speechSourceLang;
    const translated = sameLang ? "" : await fetchTranslation(transcript, state.speechTargetLang || "en");

    _io.emit("speechResult", { original: transcript, translated });
    _io.emit("speechStatus", { status: "ok", text: transcript.slice(0, 60) });
  } catch(err) {
    console.error("[speech]", err.message);
    _io.emit("speechStatus", { status: "error", text: err.message.slice(0, 80) });
  } finally {
    processing = false;
  }
}

function ytdlpGetUrl(tiktokUrl, extraArgs) {
  return new Promise((resolve, reject) => {
    const args = ["--no-warnings", "-g", "-f", "best", ...extraArgs, tiktokUrl];
    const proc = spawn(YTDLP_EXE, args, { windowsHide: true });
    let out = "", err = "";
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("error", reject);
    proc.on("close", code => {
      const url = out.trim().split("\n").find(l => l.startsWith("http"));
      if (code === 0 && url) resolve(url.trim());
      else reject(new Error(err.trim().slice(0, 150) || `exit ${code}`));
    });
  });
}

async function tryGetStreamUrl(tiktokUrl, io, getState) {
  // Try without cookies first (fastest, works for public streams)
  try {
    io.emit("speechStatus", { status: "working", text: "Đang lấy stream URL..." });
    const url = await ytdlpGetUrl(tiktokUrl, []);
    startStreamCapture(url, io, getState);
    return;
  } catch(e) {
    // If not live — no point retrying with cookies
    if (e.message.includes("not currently live") || e.message.includes("does not exist")) {
      const msg = "Idol chưa livestream";
      console.log("[speech]", msg);
      io.emit("speechStatus", { status: "error", text: msg });
      return;
    }
    console.log("[speech] no-cookie attempt failed:", e.message.slice(0, 80));
  }

  // Retry with browser cookies (for members-only streams)
  for (const browser of ["chrome", "edge", "firefox"]) {
    try {
      io.emit("speechStatus", { status: "working", text: `Thử cookie ${browser}...` });
      const url = await ytdlpGetUrl(tiktokUrl, ["--cookies-from-browser", browser]);
      startStreamCapture(url, io, getState);
      return;
    } catch(e) {
      if (e.message.includes("not currently live") || e.message.includes("does not exist")) {
        io.emit("speechStatus", { status: "error", text: "Idol chưa livestream" });
        return;
      }
      console.log(`[speech] yt-dlp (${browser}):`, e.message.slice(0, 80));
    }
  }

  io.emit("speechStatus", { status: "error", text: "Không lấy được stream URL" });
}

// Extract stream URL directly from tiktok-live-connector roomInfo
// Prefer FLV SD (lower bandwidth, sufficient for audio)
function extractFromRoomInfo(roomInfo) {
  const su = roomInfo?.data?.stream_url;
  if (!su) return null;
  return su.flv_pull_url?.SD1 ||
         su.flv_pull_url?.HD1 ||
         su.hls_pull_url     ||
         su.rtmp_pull_url    ||
         null;
}

const FFMPEG_HEADERS =
  "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n" +
  "Referer: https://www.tiktok.com/\r\n";

function startStreamCapture(streamUrl, io, getState) {
  stopStreamCapture();
  _io       = io;
  _getState = getState;
  pcmBuffer = Buffer.alloc(0);

  console.log("[speech] Starting FFmpeg stream capture:", streamUrl.slice(0, 80) + "...");

  ffmpegProc = spawn(FFMPEG_EXE, [
    "-loglevel",  "warning",
    "-headers",   FFMPEG_HEADERS,
    "-reconnect", "1",
    "-reconnect_at_eof", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", streamUrl,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-f", "s16le",
    "pipe:1"
  ], { windowsHide: true });

  ffmpegProc.stdout.on("data", (data) => {
    const state = _getState();
    if (!state.speechEnabled || !state.speechApiKey) return;

    pcmBuffer = Buffer.concat([pcmBuffer, data]);

    while (pcmBuffer.length >= CHUNK_BYTES) {
      const chunk = pcmBuffer.slice(0, CHUNK_BYTES);
      pcmBuffer   = pcmBuffer.slice(CHUNK_BYTES);
      const wav   = buildWav(chunk);
      processWav(wav.toString("base64"));
    }
  });

  ffmpegProc.stderr.on("data", (data) => {
    const msg = data.toString();
    if (msg.includes("error") || msg.includes("Error")) {
      console.error("[speech/ffmpeg]", msg.trim());
    }
  });

  ffmpegProc.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("[speech] Không tìm thấy ffmpeg.exe tại:", FFMPEG_EXE);
      io.emit("speechStatus", { status: "error", text: "Thiếu ffmpeg.exe trong thư mục ffmpeg/" });
    } else {
      console.error("[speech] FFmpeg error:", err.message);
      io.emit("speechStatus", { status: "error", text: err.message });
    }
    ffmpegProc = null;
  });

  ffmpegProc.on("close", (code) => {
    console.log("[speech] FFmpeg closed with code", code);
    ffmpegProc = null;
    pcmBuffer  = Buffer.alloc(0);
  });

  io.emit("speechStatus", { status: "capturing", text: "Đang capture stream..." });
}

function stopStreamCapture() {
  if (ffmpegProc) {
    ffmpegProc.kill("SIGTERM");
    ffmpegProc = null;
  }
  pcmBuffer = Buffer.alloc(0);
}

// ── Express + Socket registration ─────────────────────────────────────────

function register(app, io, getState, saveConfig) {
  app.get("/speech-capture.html", (req, res) =>
    res.sendFile(path.join(__dirname, "../public/speech-capture.html"))
  );
  app.get("/speech-overlay.html", (req, res) =>
    res.sendFile(path.join(__dirname, "../public/speech-overlay.html"))
  );

  app.post("/speech-control/set", (req, res) => {
    const state = getState();
    const { enabled, sourceLang, targetLang, apiKey, provider } = req.body || {};
    if (enabled    !== undefined) state.speechEnabled    = Boolean(enabled);
    if (sourceLang !== undefined) state.speechSourceLang = String(sourceLang);
    if (targetLang !== undefined) state.speechTargetLang = String(targetLang);
    if (apiKey     !== undefined) state.speechApiKey     = String(apiKey);
    if (provider   !== undefined && PROVIDERS[provider]) state.speechProvider = String(provider);
    io.emit("speechConfig", {
      speechEnabled:    state.speechEnabled,
      speechSourceLang: state.speechSourceLang,
      speechTargetLang: state.speechTargetLang,
      speechApiKey:     state.speechApiKey,
      speechProvider:   state.speechProvider
    });
    saveConfig();
    res.json({ success: true });
  });

  app.post("/speech-control/clear", (req, res) => {
    io.emit("speechClear");
    res.json({ success: true });
  });
}

// ── yt-dlp entry point ────────────────────────────────────────────────────

function startStreamCaptureByUsername(uniqueId, io, getState) {
  stopStreamCapture();
  _io       = io;
  _getState = getState;
  pcmBuffer = Buffer.alloc(0);

  const tiktokUrl = `https://www.tiktok.com/@${uniqueId}/live`;
  console.log("[speech] Getting stream URL via yt-dlp for:", uniqueId);
  io.emit("speechStatus", { status: "working", text: "Đang lấy stream URL qua yt-dlp..." });

  tryGetStreamUrl(tiktokUrl, io, getState);
}

module.exports = { DEFAULT_STATE, register, extractFromRoomInfo, startStreamCapture, startStreamCaptureByUsername, stopStreamCapture };
