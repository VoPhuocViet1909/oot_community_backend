const path = require("path");
require("dotenv").config({
  path: process.env.DOTENV_PATH || path.join(__dirname, "..", ".env"),
  override: true,
});

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

// Modular Routes
const authRoutes = require("./modules/auth/authRoutes");
const userRoutes = require("./modules/users/userRoutes");
const friendRoutes = require("./modules/users/friendRoutes");
const qrFriendRoutes = require("./modules/users/qrFriendRoutes");
const messageRoutes = require("./modules/messages/messageRoutes");
const groupRoutes = require("./modules/groups/groupRoutes");
const channelRoutes = require("./modules/channels/channelRoutes");
const botRoutes = require("./modules/bots/botRoutes");
const uploadRoutes = require("./modules/media/uploadRoutes");
const statsRoutes = require("./modules/stats/statsRoutes");
const messageRevokeRoutes = require("./modules/messages/messageRevokeRoutes");
const messageDeleteRoutes = require("./modules/messages/messageDeleteRoutes");
const messageForwardRoutes = require("./modules/messages/messageForwardRoutes");
const notificationRoutes = require("./modules/notifications/notificationRoutes");
const callRoutes = require("./modules/calls/callRoutes");
const reminderRoutes = require("./modules/reminders/reminderRoutes");
const noteRoutes = require("./modules/notes/noteRoutes");
const postRoutes = require("./modules/posts/postRoutes");
const storyRoutes = require("./modules/stories/storyRoutes");
const { recoverCallsOnBoot } = require("./modules/calls/callRecovery");
const { startReminderScheduler } = require("./modules/reminders/reminderScheduler");
const { initSchema } = require("./db/initSchema");

// Socket Handler
const {
  handleSocketConnection,
  socketAuthMiddleware,
  initializeIO,
} = require("./socket/socketHandler");

const app = express();
const server = http.createServer(app);

// eslint-disable-next-line no-console
console.log(`[BOOT] OTP_EMAIL_PROVIDER=${process.env.OTP_EMAIL_PROVIDER || 'console'} OTP_SMS_PROVIDER=${process.env.OTP_SMS_PROVIDER || 'console'}`);

// 1. Tách chuỗi từ .env thành một mảng các origin
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000"];

// SỬA THÀNH THẾ NÀY:
const io = new Server(server, {
  cors: {
    origin: "*", // Cho phép tất cả các nguồn kết nối Socket
    methods: ["GET", "POST"],
  },
});

app.set("socketio", io);

// SỬA THÀNH THẾ NÀY:
const corsOptions = {
  origin: "*", // Cho phép tất cả các nguồn gọi API
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static uploads
app.use("/public", express.static(path.join(__dirname, "..", "public")));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ott-community-backend" });
});

// API Routes initialization
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/friends", qrFriendRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/messages-extension", messageRevokeRoutes);
app.use("/api/messages-extension", messageDeleteRoutes);
app.use("/api/messages-extension", messageForwardRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/notes", noteRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/v1/bot", botRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/stories", storyRoutes);

// Socket.io Middleware and Initialization
app.set("io", io);
io.use(socketAuthMiddleware);
initializeIO(io);

io.on("connection", (socket) => {
  handleSocketConnection(io, socket);
});

const PORT = process.env.PORT || 4000;

initSchema()
  .catch((err) => {
    console.error("[BOOT] MySQL schema init failed:", err.message);
    process.exit(1);
  })
  .then(() => {
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(
        `OTT Community backend (Restructured) is running on port ${PORT}`,
      );

      // Phase 2d: Recover orphaned call state from previous server instance
      recoverCallsOnBoot(io).catch((err) => {
        console.error("[BOOT] Call recovery failed:", err.message);
      });

      startReminderScheduler(io);
    });
  });

module.exports = { app, server, io };
