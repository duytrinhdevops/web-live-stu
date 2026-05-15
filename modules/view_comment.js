const path = require("path");

const DEFAULT_STATE = {
  commentVisible: true,
  commentSize: 18
};

function register(app, io, getRoom, saveRoomConfig) {
  app.get("/comment.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/comment.html"));
  });

  app.post("/room/:roomId/comment-control/set", (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });
    const { visible, size } = req.body || {};
    if (visible !== undefined) room.state.commentVisible = Boolean(visible);
    if (size !== undefined && Number.isFinite(Number(size))) room.state.commentSize = Number(size);
    io.to(req.params.roomId).emit("commentConfig", {
      commentVisible: room.state.commentVisible,
      commentSize:    room.state.commentSize
    });
    saveRoomConfig(req.params.roomId);
    res.json({ success: true });
  });

  app.post("/room/:roomId/comment-control/clear", (req, res) => {
    if (!getRoom(req.params.roomId)) return res.status(404).json({ success: false });
    io.to(req.params.roomId).emit("commentClear");
    res.json({ success: true });
  });
}

function attachChatListener(conn, roomId, io, getRoom) {
  conn.on("chat", data => {
    if (getRoom && getRoom(roomId)?.connection !== conn) return;
    const message = (data.comment || "").trim();
    if (!message) return;
    if (getRoom) {
      const bl = getRoom(roomId)?.state?.commentBlacklist;
      if (Array.isArray(bl) && bl.length > 0) {
        const lower = message.toLowerCase();
        if (bl.some(w => lower.includes(w.toLowerCase()))) return;
      }
    }
    const user =
      data.nickname ||
      data.uniqueId ||
      data.userDetails?.nickname ||
      data.userDetails?.uniqueId ||
      "Unknown";
    io.to(roomId).emit("commentDrop", { username: user, message });
  });
}

module.exports = { DEFAULT_STATE, register, attachChatListener };
