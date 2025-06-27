require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const jwt = require("jsonwebtoken");
const { createAdapter } = require("@socket.io/redis-adapter");
const { RateLimiterRedis } = require("rate-limiter-flexible");
const { Channel } = require("./models/chatModels");
const Reward = require("./models/RewardModel");
const { VenueCity } = require("./models/eventModel");

const {
  invokeGroupAssignment,
  sendFollowUpEmails,
  sendVenueNotifications,
} = require("./consumers/groupAssignmentConsumer");
const autoCancelAndRefund = require("./consumers/autoCancellation");

const authRouter = require("./routers/authRouter");
const feedbackRouter = require("./routers/feedbackRouter");
const locationRouter = require("./routers/serviceRouter");
const userDetailsRouter = require("./routers/userDetailsRouter");
const uploadRouter = require("./routers/uploadRouter");
const verifyRouter = require("./routers/phoneVerifyRouter");
const paymentsRouter = require("./routers/paymentsRouter");
const chatRouter = require("./routers/chatRouter");
const notisRouter = require("./routers/notificationsRouter");
const referralRouter = require("./routers/ReferralCodeRouter");
const eventsRouter = require("./routers/eventRouter");
const attendanceRouter = require("./routers/attendanceRouter");
const userTracker = require("./routers/userTracker");

//kafka
const { initKafka } = require("./utils/kafka");

//consumers
require("./consumers/chatConsumer");
require("./consumers/notificationConsumer");
require("./consumers/notificationConsumers/emailConsumer");
require("./consumers/paymentConsumer");
require("./consumers/groupAssignmentConsumer");
require("./consumers/latePaymentConsumer");
require("./consumers/deadLetterWorker");

//utils
require("./utils/nudgeUsers");

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  "https://venue-panel-meet-and-more.vercel.app",
  "https://meetandmore-media.s3.eu-north-1.amazonaws.com",
  "http://localhost:5173",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  process.env.CLIENT_ORIGIN,
  "capacitor://localhost",
  "https://api.meetandmore.com",
  "http://localhost",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log(`❌ Origin blocked: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Admin-Code", "Authorization"],
  })
);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback("Not allowed by Socket.IO CORS");
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  },
});

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
const redisClient = pubClient;

Promise.all([pubClient.connect(), subClient.connect()])
  .then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log("Redis and adapter connected");
  })
  .catch((err) => {
    console.error("Redis connection error:", err);
    process.exit(1);
  });

const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: "socket-rate",
  points: 10,
  duration: 1,
});

app.use(helmet());

// Call Kafka connection once during app startup
initKafka()
  .then(() => console.log("Kafka interface connected with BullMQ"))
  .catch((err) => {
    console.error("Kafka interface connection failed:", err);
    process.exit(1);
  });

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: "Too many requests, please try again after 15 minutes",
  },
});

app.use(limiter);
// Enable trust proxy to handle X-Forwarded-For header
app.set("trust proxy", 1); // Trust the first proxy (localtunnel in dev)

app.get("/", (req, res) => {
  res.send("MeetandMore server healthy...");
});

const initializeApp = async () => {
  await Reward.initializeDefaultRewards();
  console.log("Default rewards initialized");
  await VenueCity.initializeDefaultCities();
  console.log("Default cities initialized");
};

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    initializeApp();
  })
  .catch((err) => console.error("MongoDB connection error:", err));

app.use("/api/payments", paymentsRouter);

app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/services", locationRouter);
app.use("/api/userDetails", userDetailsRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/phoneVerify", verifyRouter);
// app.use("/api/payments", paymentsRouter);
app.use("/api/chats", chatRouter);
app.use("/api/notify", notisRouter);
app.use("/api/referrals", referralRouter);
app.use("/api/events", eventsRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/tracker", userTracker);

//auto cancel
// autoCancelAndRefund(["50bb4793-0825-4f4d-b15b-de7fcb615a49"]);
// invokeGroupAssignment("160f03c4-f01a-4f3b-b702-0806f3f6c472");
// sendFollowUpEmails("160f03c4-f01a-4f3b-b702-0806f3f6c472");
// sendVenueNotifications("160f03c4-f01a-4f3b-b702-0806f3f6c472");

// Helper for safe Redis operations
const safeRedis = async (fn, operationName) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error  in ${operationName}:`, err);
    throw err; // Throw to allow explicit handling
  }
};

const socketHandler = async (io, redisClient, rateLimiter) => {
  // Verify Redis connection
  if (!redisClient.isOpen) {
    console.error("Redis client not connected. Falling back to MongoDB.");
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication error: Missing token"));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.uuid;
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid or expired token"));
    }
  });

  io.on("connection", async (socket) => {
    const { userId } = socket;
    if (!userId) return;

    try {
      // Check Redis for user's channels first
      let channelIds = await safeRedis(
        () => redisClient.sMembers(`userChannels:${userId}`),
        "fetch userChannels"
      );

      if (!channelIds || channelIds.length === 0) {
        // Fallback to MongoDB if Redis is empty or unavailable
        const channels = await Channel.find({
          participants: userId,
          blockedBy: { $ne: userId },
        })
          .select("_id")
          .lean();
        channelIds = channels.map((c) => c._id.toString());

        if (channelIds.length > 0) {
          // Update Redis with channel data
          const multi = redisClient.multi();
          for (const id of channelIds) {
            multi.sAdd(`channelReceivers:${id}`, userId);
            multi.sAdd(`userChannels:${userId}`, id);
            multi.expire(`channelReceivers:${id}`, 43200);
          }
          multi.expire(`userChannels:${userId}`, 43200);
          await safeRedis(() => multi.exec(), "update userChannels");
        }
      }

      // Join Socket.IO rooms and update sockets
      const multi = redisClient.multi();
      for (const id of channelIds) {
        try {
          socket.join(`channel:${id}`);
          socket
            .to(`channel:${id}`)
            .emit("onlineUser", { channelId: id, userId, online: true });
        } catch (err) {
          console.error(`Failed to join channel:${id}:`, err);
        }
      }
      multi.sAdd(`sockets:${userId}`, socket.id);
      multi.expire(`sockets:${userId}`, 900);
      multi.sAdd("onlineUsers", userId);
      await safeRedis(() => multi.exec(), "update sockets and onlineUsers");

      console.log(`User ${userId} connected with socket ${socket.id}`);

      const refreshTTLs = async (channelId) => {
        const multi = redisClient.multi();
        multi.expire(`userChannels:${userId}`, 43200);
        multi.expire(`channelReceivers:${channelId}`, 43200);
        multi.expire(`sockets:${userId}`, 900);
        multi.expire(`notAllowed:${channelId}`, 43200);
        await safeRedis(
          () => multi.exec(),
          `refreshTTLs for channel:${channelId}`
        );
      };

      socket.on("message", async (data) => {
        try {
          const { channelId, payload } = data;

          if (!channelId || !payload) {
            return socket.emit("error", {
              message: "Channel ID and payload required",
            });
          }

          let isAuthorized = await safeRedis(
            () => redisClient.sIsMember(`userChannels:${userId}`, channelId),
            "check userChannels for message"
          );

          if (!isAuthorized) {
            const channel = await Channel.findOne({
              _id: channelId,
              participants: userId,
              blockedBy: { $ne: userId },
            });
            if (!channel) {
              await safeRedis(
                () => redisClient.sAdd(`notAllowed:${channelId}`, userId),
                "add to notAllowed"
              );
              await safeRedis(
                () => redisClient.expire(`notAllowed:${channelId}`, 43200),
                "set notAllowed TTL"
              );
              return socket.emit("error", {
                message: "Channel not found or access denied",
              });
            }

            // Update Redis sets for authorization
            const multi = redisClient.multi();
            multi.sAdd(`userChannels:${userId}`, channelId);
            multi.sAdd(`channelReceivers:${channelId}`, userId);
            multi.sAdd(`sockets:${userId}`, socket.id);
            multi.sRem(`notAllowed:${channelId}`, userId); // Clear notAllowed
            await safeRedis(
              () => multi.exec(),
              "update Redis sets for message authorization"
            );
          }

          await refreshTTLs(channelId);

          socket
            .to(`channel:${channelId}`)
            .emit("message", { chat: payload, channelId });
        } catch (err) {
          if (err instanceof Error && err.msBeforeNext) {
            socket.emit("error", {
              message: "Rate limit exceeded. Try again later.",
            });
          } else {
            console.error("Message error:", err);
            socket.emit("error", { message: "Failed to send message" });
          }
        }
      });

      socket.on("joinChannel", async (channelId) => {
        try {
          // Check Redis for authorization first
          let isAuthorized = await safeRedis(
            () =>
              redisClient.sIsMember(`channelReceivers:${channelId}`, userId),
            "check channelReceivers for join"
          );

          if (!isAuthorized) {
            // Fallback to MongoDB

            const channel = await Channel.findOne({
              _id: channelId,
              participants: userId,
              blockedBy: { $ne: userId },
            });
            if (!channel) {
              await safeRedis(
                () => redisClient.sAdd(`notAllowed:${channelId}`, userId),
                "add to notAllowed"
              );
              await safeRedis(
                () => redisClient.expire(`notAllowed:${channelId}`, 43200),
                "set notAllowed TTL"
              );
              return socket.emit("error", {
                message: "Channel not found or access denied",
              });
            }

            // Update Redis sets for authorization
            const multi = redisClient.multi();
            multi.sAdd(`userChannels:${userId}`, channelId);
            multi.sAdd(`channelReceivers:${channelId}`, userId);
            multi.sAdd(`sockets:${userId}`, socket.id);
            multi.sRem(`notAllowed:${channelId}`, userId); // Clear notAllowed
            await safeRedis(
              () => multi.exec(),
              "update Redis sets for message authorization"
            );
          }

          try {
            socket.join(`channel:${channelId}`);
          } catch (err) {
            console.error(`Failed to join channel:${channelId}:`, err);
            return socket.emit("error", { message: "Failed to join channel" });
          }

          await refreshTTLs(channelId);

          socket.emit("joinedChannel", { channelId });
        } catch (err) {
          console.error("Join channel error:", err);
          socket.emit("error", { message: "Failed to join channel" });
        }
      });

      socket.on("leaveChannel", async (channelId) => {
        try {
          // Check if user was authorized
          const isMember = await safeRedis(
            () =>
              redisClient.sIsMember(`channelReceivers:${channelId}`, userId),
            "check channelReceivers for leave"
          );
          // if (!isMember) {
          //   await safeRedis(
          //     () => redisClient.sAdd(`notAllowed:${channelId}`, userId),
          //     "add to notAllowed"
          //   );
          //   await safeRedis(
          //     () => redisClient.expire(`notAllowed:${channelId}`, 43200),
          //     "set notAllowed TTL"
          //   );
          //   try {
          //     socket.leave(`channel:${channelId}`); // Safety in case keys expire
          //   } catch (err) {
          //     console.error(`Failed to leave channel:${channelId}:`, err);
          //   }
          //   return socket.emit("error", {
          //     message: "Not a member of this channel",
          //   });
          // }

          try {
            socket.leave(`channel:${channelId}`);
          } catch (err) {
            console.error(`Failed to leave channel:${channelId}:`, err);
          }

          const multi = redisClient.multi();
          multi.sRem(`channelReceivers:${channelId}`, userId);
          multi.sRem(`userChannels:${userId}`, channelId);
          multi.expire(`channelReceivers:${channelId}`, 43200);
          multi.expire(`userChannels:${userId}`, 43200);
          await safeRedis(
            () => multi.exec(),
            "update channelReceivers for leave"
          );

          socket.emit("leftChannel", { channelId });
        } catch (err) {
          console.error("Leave channel error:", err);
          socket.emit("error", { message: "Failed to leave channel" });
        }
      });

      socket.on("disconnect", async () => {
        try {
          const multi = redisClient.multi();
          multi.sRem("onlineUsers", userId);
          multi.sRem(`sockets:${userId}`, socket.id);
          await safeRedis(
            () => multi.exec(),
            "update onlineUsers on disconnect"
          );

          const socketsLeft = await safeRedis(
            () => redisClient.sCard(`sockets:${userId}`),
            "check socketsLeft"
          );
          if (!socketsLeft) {
            const userChannels = await safeRedis(
              () => redisClient.sMembers(`userChannels:${userId}`),
              "fetch userChannels for disconnect"
            );
            const multiCleanup = redisClient.multi();
            for (const id of userChannels || []) {
              multiCleanup.sRem(`channelReceivers:${id}`, userId);
              multiCleanup.expire(`channelReceivers:${id}`, 43200);
              // Emit onlineUser on disconnection
              socket
                .to(`channel:${id}`)
                .emit("onlineUser", { channelId: id, userId, online: false });
            }
            multiCleanup.del(`userChannels:${userId}`);
            await safeRedis(() => multiCleanup.exec(), "cleanup userChannels");
          }

          console.log(`User ${userId} disconnected`);
        } catch (err) {
          console.error("Disconnect error:", err);
        }
      });
    } catch (err) {
      console.error("Socket connection error:", err);
    }
  });
};

socketHandler(io, redisClient, rateLimiter);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
