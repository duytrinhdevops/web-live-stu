const https  = require("https");
const path   = require("path");
const { spawn } = require("child_process");

const IS_WIN     = process.platform === "win32";
const BIN_DIR    = path.join(__dirname, "../ffmpeg");
const FFMPEG_EXE = IS_WIN ? path.join(BIN_DIR, "ffmpeg.exe") : "ffmpeg";
const YTDLP_EXE  = IS_WIN ? path.join(BIN_DIR, "yt-dlp.exe") : path.join(BIN_DIR, "yt-dlp");

const DEFAULT_STATE = {
  speechEnabled:    false,
  speechSourceLang: "vi",
  speechTargetLang: "en",
  speechProvider:   "groq",
  speechApiKey:     ""
};

const PROVIDERS = {
  groq:   { hostname: "api.groq.com",  path: "/openai/v1/audio/transcriptions", model: "whisper-large-v3-turbo" },
  openai: { hostname: "api.openai.com", path: "/v1/audio/transcriptions",        model: "whisper-1" }
};

// ── Per-room process state ─────────────────────────────────────────────────

const roomProcs = new Map();

function getRoomProc(roomId) {
  if (!roomProcs.has(roomId)) {
    roomProcs.set(roomId, {
      ffmpegProc: null,
      pcmBuffer:  Buffer.alloc(0),
      processing: false,
      _io:        null,
      _getState:  null
    });
  }
  return roomProcs.get(roomId);
}

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
        "Authorization":  `Bearer ${apiKey}`,
        "Content-Type":   `multipart/form-data; boundary=${boundary}`,
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

// ── Audio processing ───────────────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const CHUNK_SECS  = 6;
const CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_SECS;

async function processWav(roomId, wavBase64) {
  const rp = getRoomProc(roomId);
  if (rp.processing) return;
  rp.processing = true;
  try {
    const state = rp._getState();
    if (!state.speechEnabled || !state.speechApiKey) return;
    const transcript = await callWhisper(
      wavBase64,
      state.speechSourceLang || "vi",
      state.speechApiKey,
      state.speechProvider  || "groq"
    );
    if (isJunk(transcript)) return;
    const sameLang   = state.speechTargetLang === state.speechSourceLang;
    const translated = sameLang ? "" : await fetchTranslation(transcript, state.speechTargetLang || "en");
    rp._io.to(roomId).emit("speechResult", { original: transcript, translated });
    rp._io.to(roomId).emit("speechStatus", { status: "ok", text: transcript.slice(0, 60) });
  } catch(err) {
    console.error("[speech]", err.message);
    rp._io.to(roomId).emit("speechStatus", { status: "error", text: err.message.slice(0, 80) });
  } finally {
    rp.processing = false;
  }
}

// ── yt-dlp helpers ─────────────────────────────────────────────────────────

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

async function tryGetStreamUrl(roomId, tiktokUrl, io, getState) {
  try {
    io.to(roomId).emit("speechStatus", { status: "working", text: "Đang lấy stream URL..." });
    const url = await ytdlpGetUrl(tiktokUrl, []);
    startStreamCapture(roomId, url, io, getState);
    return;
  } catch(e) {
    if (e.message.includes("not currently live") || e.message.includes("does not exist")) {
      const msg = "Idol chưa livestream";
      console.log("[speech]", msg);
      io.to(roomId).emit("speechStatus", { status: "error", text: msg });
      return;
    }
    console.log("[speech] no-cookie attempt failed:", e.message.slice(0, 80));
  }

  for (const browser of ["chrome", "edge", "firefox"]) {
    try {
      io.to(roomId).emit("speechStatus", { status: "working", text: `Thử cookie ${browser}...` });
      const url = await ytdlpGetUrl(tiktokUrl, ["--cookies-from-browser", browser]);
      startStreamCapture(roomId, url, io, getState);
      return;
    } catch(e) {
      if (e.message.includes("not currently live") || e.message.includes("does not exist")) {
        io.to(roomId).emit("speechStatus", { status: "error", text: "Idol chưa livestream" });
        return;
      }
      console.log(`[speech] yt-dlp (${browser}):`, e.message.slice(0, 80));
    }
  }
  io.to(roomId).emit("speechStatus", { status: "error", text: "Không lấy được stream URL" });
}

// ── Stream URL from roomInfo ───────────────────────────────────────────────

function extractFromRoomInfo(roomInfo) {
  const su = roomInfo?.data?.stream_url;
  if (!su) return null;
  return su.flv_pull_url?.SD1 || su.flv_pull_url?.HD1 || su.hls_pull_url || su.rtmp_pull_url || null;
}

const FFMPEG_HEADERS =
  "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n" +
  "Referer: https://www.tiktok.com/\r\n";

// ── FFmpeg stream capture ──────────────────────────────────────────────────

function startStreamCapture(roomId, streamUrl, io, getState) {
  stopStreamCapture(roomId);
  const rp = getRoomProc(roomId);
  rp._io       = io;
  rp._getState = getState;
  rp.pcmBuffer = Buffer.alloc(0);

  console.log(`[speech:${roomId}] Starting FFmpeg:`, streamUrl.slice(0, 80) + "...");

  rp.ffmpegProc = spawn(FFMPEG_EXE, [
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

  rp.ffmpegProc.stdout.on("data", (data) => {
    const state = rp._getState();
    if (!state.speechEnabled || !state.speechApiKey) return;
    rp.pcmBuffer = Buffer.concat([rp.pcmBuffer, data]);
    while (rp.pcmBuffer.length >= CHUNK_BYTES) {
      const chunk  = rp.pcmBuffer.slice(0, CHUNK_BYTES);
      rp.pcmBuffer = rp.pcmBuffer.slice(CHUNK_BYTES);
      processWav(roomId, buildWav(chunk).toString("base64"));
    }
  });

  rp.ffmpegProc.stderr.on("data", (data) => {
    const msg = data.toString();
    if (msg.includes("error") || msg.includes("Error")) {
      console.error(`[speech/ffmpeg:${roomId}]`, msg.trim());
    }
  });

  rp.ffmpegProc.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("[speech] ffmpeg not found:", FFMPEG_EXE);
      io.to(roomId).emit("speechStatus", { status: "error", text: "Thiếu ffmpeg" });
    } else {
      io.to(roomId).emit("speechStatus", { status: "error", text: err.message });
    }
    rp.ffmpegProc = null;
  });

  rp.ffmpegProc.on("close", (code) => {
    console.log(`[speech:${roomId}] FFmpeg closed with code`, code);
    rp.ffmpegProc = null;
    rp.pcmBuffer  = Buffer.alloc(0);
  });

  io.to(roomId).emit("speechStatus", { status: "capturing", text: "Đang capture stream..." });
}

function stopStreamCapture(roomId) {
  if (!roomProcs.has(roomId)) return;
  const rp = roomProcs.get(roomId);
  if (rp.ffmpegProc) {
    rp.ffmpegProc.kill("SIGTERM");
    rp.ffmpegProc = null;
  }
  rp.pcmBuffer = Buffer.alloc(0);
}

function startStreamCaptureByUsername(roomId, uniqueId, io, getState) {
  stopStreamCapture(roomId);
  const rp     = getRoomProc(roomId);
  rp._io       = io;
  rp._getState = getState;
  rp.pcmBuffer = Buffer.alloc(0);
  const tiktokUrl = `https://www.tiktok.com/@${uniqueId}/live`;
  console.log(`[speech:${roomId}] Getting stream URL via yt-dlp for:`, uniqueId);
  io.to(roomId).emit("speechStatus", { status: "working", text: "Đang lấy stream URL qua yt-dlp..." });
  tryGetStreamUrl(roomId, tiktokUrl, io, getState);
}

// ── Express + Socket registration ─────────────────────────────────────────

function register(app, io, getRoom, saveRoomConfig) {
  app.get("/speech-capture.html", (req, res) =>
    res.sendFile(path.join(__dirname, "../public/speech-capture.html"))
  );
  app.get("/speech-overlay.html", (req, res) =>
    res.sendFile(path.join(__dirname, "../public/speech-overlay.html"))
  );

  app.post("/room/:roomId/speech-control/set", (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ success: false });
    const { enabled, sourceLang, targetLang, apiKey, provider } = req.body || {};
    if (enabled    !== undefined) room.state.speechEnabled    = Boolean(enabled);
    if (sourceLang !== undefined) room.state.speechSourceLang = String(sourceLang);
    if (targetLang !== undefined) room.state.speechTargetLang = String(targetLang);
    if (apiKey     !== undefined) room.state.speechApiKey     = String(apiKey);
    if (provider   !== undefined && PROVIDERS[provider]) room.state.speechProvider = String(provider);
    io.to(req.params.roomId).emit("speechConfig", {
      speechEnabled:    room.state.speechEnabled,
      speechSourceLang: room.state.speechSourceLang,
      speechTargetLang: room.state.speechTargetLang,
      speechProvider:   room.state.speechProvider
      // speechApiKey không gửi qua socket
    });
    saveRoomConfig(req.params.roomId);
    res.json({ success: true });
  });

  app.post("/room/:roomId/speech-control/clear", (req, res) => {
    if (!getRoom(req.params.roomId)) return res.status(404).json({ success: false });
    io.to(req.params.roomId).emit("speechClear");
    res.json({ success: true });
  });
}

module.exports = { DEFAULT_STATE, register, extractFromRoomInfo, startStreamCapture, startStreamCaptureByUsername, stopStreamCapture };
