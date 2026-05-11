const path = require("path");

// Giá trị mặc định — được merge vào defaultState() của server
const DEFAULT_STATE = {
  commentVisible: true,
  commentSize: 18
};

// Đăng ký routes và socket events liên quan đến comment
function register(app, io, getState, saveConfig) {
  app.get("/comment.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/comment.html"));
  });

  app.post("/comment-control/set", (req, res) => {
    const state = getState();
    const { visible, size } = req.body || {};
    if (visible !== undefined) state.commentVisible = Boolean(visible);
    if (size !== undefined && Number.isFinite(Number(size))) state.commentSize = Number(size);
    io.emit("commentConfig", {
      commentVisible: state.commentVisible,
      commentSize: state.commentSize
    });
    saveConfig();
    res.json({ success: true });
  });

  app.post("/comment-control/clear", (req, res) => {
    io.emit("commentClear");
    res.json({ success: true });
  });
}

// Gắn listener chat vào một TikTok connection
function attachChatListener(conn, io) {
  conn.on("chat", data => {
    const message = (data.comment || "").trim();
    if (!message) return;
    const user =
      data.nickname ||
      data.uniqueId ||
      data.userDetails?.nickname ||
      data.userDetails?.uniqueId ||
      "Unknown";
    io.emit("commentDrop", { username: user, message });
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };
