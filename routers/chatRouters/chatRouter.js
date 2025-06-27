const express = require("express");
const { body, query, validationResult } = require("express-validator");
const { v4: uuidv4 } = require("uuid");
const { Chat, Channel } = require("../../models/chatModels");
const verifyJWT = require("../../middlewares/verifyJWT");
const redis = require("redis");
const { sendMessageToKafka } = require("../../utils/kafka");
const router = express.Router();

// Redis client setup
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

// Helper for safe Redis operations
const safeRedis = async (fn, operationName) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error in ${operationName}:`, err);
    throw err;
  }
};

// Utility to format errors
const formatError = (msg) => ({ success: false, message: msg, data: null });

// Insert a chat (message or media)
router.post(
  "/",
  verifyJWT,
  [
    body("channelId").isString().notEmpty().withMessage("Channel ID required"),
    body("type").isIn(["message", "media"]).withMessage("Invalid type"),
    body("message")
      .if(body("type").equals("message"))
      .notEmpty()
      .withMessage("Message required for type 'message'"),
    body("media")
      .if(body("type").equals("media"))
      .notEmpty()
      .withMessage("Media URL required for type 'media'"),
    body("mediaType")
      .if(body("type").equals("media"))
      .isIn(["image", "video", "file"])
      .withMessage("Invalid media type"),
    body("replyTo").optional().isString().withMessage("Invalid replyTo ID"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json(formatError(errors.array()[0].msg));

    const { channelId, type, message, media, mediaType, replyTo } = req.body;
    const userId = req.user.uuid;

    try {
      // Check Redis for authorization
      const isAuthorized = await safeRedis(
        () => redisClient.sIsMember(`channelReceivers:${channelId}`, userId),
        `check channelReceivers:${channelId}`
      );

      if (!isAuthorized) {
        // Check if user is in notAllowed set to avoid MongoDB query
        const isNotAllowed = await safeRedis(
          () => redisClient.sIsMember(`notAllowed:${channelId}`, userId),
          `check notAllowed:${channelId}`
        );
        if (isNotAllowed) {
          return res
            .status(403)
            .json(formatError("Channel not found or access denied"));
        }

        // Fallback to MongoDB
        const channel = await Channel.findOne({
          _id: channelId,
          participants: userId,
          blockedBy: { $ne: userId },
        }).lean();

        if (!channel) {
          // Add to notAllowed set
          const multi = redisClient.multi();
          multi.sAdd(`notAllowed:${channelId}`, userId);
          multi.expire(`notAllowed:${channelId}`, 43200);
          await safeRedis(() => multi.exec(), `update notAllowed:${channelId}`);
          return res
            .status(403)
            .json(formatError("Channel not found or access denied"));
        }

        // Update Redis sets
        const multi = redisClient.multi();
        multi.sAdd(`channelReceivers:${channelId}`, userId);
        multi.sAdd(`userChannels:${userId}`, channelId);
        multi.expire(`channelReceivers:${channelId}`, 43200);
        multi.expire(`userChannels:${userId}`, 43200);
        await safeRedis(
          () => multi.exec(),
          `update channelReceivers:${channelId}`
        );
      }

      // Create chat
      const chat = {
        _id: uuidv4(),
        channelId,
        type,
        from: userId,
        message: type === "message" ? message : undefined,
        media: type === "media" ? media : undefined,
        mediaType: type === "media" ? mediaType : undefined,
        replyTo,
        time: new Date().toISOString(),
      };

      await sendMessageToKafka("chat-messages", chat);
      // Refresh TTLs
      const multi = redisClient.multi();
      multi.expire(`channelReceivers:${channelId}`, 43200);
      multi.expire(`userChannels:${userId}`, 43200);
      multi.expire(`notAllowed:${channelId}`, 43200);
      await safeRedis(
        () => multi.exec(),
        `refresh TTLs for channel:${channelId}`
      );

      return res.status(201).json({
        success: true,
        message: "Chat created successfully",
        data: chat,
      });
    } catch (err) {
      console.error("Chat insert error:", err);
      return res.status(500).json(formatError("Server error"));
    }
  }
);

// Insert multiple chats - not be used many times
router.post(
  "/bulk",
  verifyJWT,
  [
    body("chats")
      .isArray({ min: 1 })
      .withMessage("Chats must be a non-empty array"),
    body("chats.*.channelId")
      .isString()
      .notEmpty()
      .withMessage("Channel ID required"),
    body("chats.*.type").isIn(["message", "media"]).withMessage("Invalid type"),
    body("chats.*.message")
      .if(body("chats.*.type").equals("message"))
      .notEmpty()
      .withMessage("Message required for type 'message'"),
    body("chats.*.media")
      .if(body("chats.*.type").equals("media"))
      .notEmpty()
      .withMessage("Media URL required for type 'media'"),
    body("chats.*.mediaType")
      .if(body("chats.*.type").equals("media"))
      .isIn(["image", "video", "file"])
      .withMessage("Invalid media type"),
    body("chats.*.replyTo")
      .optional()
      .isString()
      .withMessage("Invalid replyTo ID"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json(formatError(errors.array()[0].msg));

    const { chats } = req.body;
    const userId = req.user.uuid;
    const insertedChats = [];

    try {
      const channelIds = [...new Set(chats.map((chat) => chat.channelId))];

      // Step 1: Check Redis for receiver membership
      const multi = redisClient.multi();
      const receiverKeys = channelIds.map((id) => `channelReceivers:${id}`);
      receiverKeys.forEach((key) => multi.sIsMember(key, userId));
      const results = await safeRedis(() => multi.exec(), "check receivers");

      // Step 2: Identify missing channels
      const missingChannelIds = [];
      channelIds.forEach((id, index) => {
        const isMember = Array.isArray(results[index])
          ? results[index][1]
          : results[index];
        if (!isMember) missingChannelIds.push(id);
      });
      // Step 3: Query MongoDB for missing authorization
      let authorizedChannelSet = new Set(
        channelIds.filter((id) => !missingChannelIds.includes(id))
      );

      if (missingChannelIds.length > 0) {
        const fetched = await Channel.find({
          _id: { $in: missingChannelIds },
          participants: userId,
          blockedBy: { $ne: userId },
        }).lean();
        fetched.forEach((channel) => {
          authorizedChannelSet.add(channel._id.toString());
        });

        const notAllowedChannels = missingChannelIds.filter(
          (id) => !authorizedChannelSet.has(id)
        );
        if (notAllowedChannels.length) {
          return res
            .status(403)
            .json(
              formatError(
                `Access denied to channel(s): ${notAllowedChannels.join(", ")}`
              )
            );
        }

        // Step 4: Cache newly authorized channels
        const multiUpdate = redisClient.multi();
        fetched.forEach((channel) => {
          const id = channel._id.toString();
          multiUpdate.sAdd(`channelReceivers:${id}`, userId);
          multiUpdate.expire(`channelReceivers:${id}`, 43200);
          multiUpdate.sAdd(`userChannels:${userId}`, id);
        });
        multiUpdate.expire(`userChannels:${userId}`, 43200);
        await safeRedis(() => multiUpdate.exec(), "cache new auth");
      }

      // Step 5: Prepare chat documents
      const chatDocs = chats.map((chat) => {
        if (!authorizedChannelSet.has(chat.channelId)) {
          throw new Error(`Unauthorized channel: ${chat.channelId}`);
        }

        const chatId = uuidv4();
        insertedChats.push({
          chatId,
          channelId: chat.channelId,
          type: chat.type,
          from: userId,
          message: chat.type === "message" ? chat.message : undefined,
          media: chat.type === "media" ? chat.media : undefined,
          mediaType: chat.type === "media" ? chat.mediaType : undefined,
          replyTo: chat.replyTo,
        });

        return {
          _id: chatId,
          channelId: chat.channelId,
          type: chat.type,
          from: userId,
          message: chat.type === "message" ? chat.message : undefined,
          media: chat.type === "media" ? chat.media : undefined,
          mediaType: chat.type === "media" ? chat.mediaType : undefined,
          replyTo: chat.replyTo,
          time: new Date(),
        };
      });

      // Step 6: Bulk insert
      await Chat.insertMany(chatDocs);

      // Step 7: Refresh TTLs
      const multiTtl = redisClient.multi();
      channelIds.forEach((id) => {
        multiTtl.expire(`channelReceivers:${id}`, 43200);
      });
      multiTtl.expire(`userChannels:${userId}`, 43200);
      await safeRedis(() => multiTtl.exec(), "refresh TTLs");

      return res.status(201).json({
        success: true,
        message: "Chats created successfully",
        data: insertedChats,
      });
    } catch (err) {
      console.error("Bulk chat insert error:", err);
      return res.status(500).json(formatError("Server error"));
    }
  }
);

// New route: Get newer chats for a channel after a time - 60 chats/req
router.get(
  "/newer",
  verifyJWT,
  [
    query("channelId").isString().notEmpty().withMessage("Channel ID required"),
    query("time")
      .isISO8601()
      .toDate()
      .withMessage("Time must be a valid ISO8601 date"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(formatError(errors.array()[0].msg));
    }

    const userId = req.user.uuid;
    const { channelId, time } = req.query;

    try {
      // Check Redis for channel authorization
      const isAuthorized = await safeRedis(
        () => redisClient.sIsMember(`channelReceivers:${channelId}`, userId),
        `check channelReceivers:${channelId}`
      );

      if (!isAuthorized) {
        const isNotAllowed = await safeRedis(
          () => redisClient.sIsMember(`notAllowed:${channelId}`, userId),
          `check notAllowed:${channelId}`
        );
        if (isNotAllowed) {
          return res
            .status(403)
            .json(formatError("Channel not found or access denied"));
        }

        // Fallback to MongoDB
        const channel = await Channel.findOne({
          _id: channelId,
          participants: userId,
          blockedBy: { $ne: userId },
          // deletedBy: { $ne: userId },
        }).lean();

        if (!channel) {
          const multi = redisClient.multi();
          multi.sAdd(`notAllowed:${channelId}`, userId);
          multi.expire(`notAllowed:${channelId}`, 43200);
          await safeRedis(() => multi.exec(), `update notAllowed:${channelId}`);
          return res
            .status(403)
            .json(formatError("Channel not found or access denied"));
        }

        // Update Redis sets
        const multi = redisClient.multi();
        multi.sAdd(`channelReceivers:${channelId}`, userId);
        multi.sAdd(`userChannels:${userId}`, channelId);
        multi.expire(`channelReceivers:${channelId}`, 43200);
        multi.expire(`userChannels:${userId}`, 43200);
        await safeRedis(
          () => multi.exec(),
          `update channelReceivers:${channelId}`
        );
      }

      // Fetch chats after the specified time
      const query = {
        channelId,
        isDeleted: { $ne: true },
        time: { $gte: new Date(time) },
      };

      const chats = await Chat.find(query).sort({ time: 1 }).limit(60).lean();

      // Refresh TTLs
      const multi = redisClient.multi();
      multi.expire(`channelReceivers:${channelId}`, 43200);
      multi.expire(`userChannels:${userId}`, 43200);
      multi.expire(`notAllowed:${channelId}`, 43200);
      await safeRedis(
        () => multi.exec(),
        `refresh TTLs for channel:${channelId}`
      );

      return res.status(200).json({
        success: true,
        message: "Newer chats fetched successfully",
        data: { chats, userId },
      });
    } catch (err) {
      console.error("Newer chats fetch error:", err);
      return res.status(500).json(formatError("Server error"));
    }
  }
);

// GET /latest (single latest message across all user channels)
router.get("/latest", verifyJWT, async (req, res) => {
  const userId = req.user?.uuid;

  try {
    // Get user channels from Redis
    let channelIds = await safeRedis(
      () => redisClient.sMembers(`userChannels:${userId}`),
      `fetch userChannels:${userId}`
    );

    // Fallback to MongoDB if Redis is empty
    if (!channelIds || channelIds.length === 0) {
      const channels = await Channel.find({
        participants: userId,
        blockedBy: { $ne: userId },
      }).lean();
      channelIds = channels.map((ch) => ch._id.toString());

      // Update Redis
      if (channelIds.length > 0) {
        const multi = redisClient.multi();
        for (const channelId of channelIds) {
          multi.sAdd(`channelReceivers:${channelId}`, userId);
          multi.sAdd(`userChannels:${userId}`, channelId);
          multi.expire(`channelReceivers:${channelId}`, 43200);
        }
        multi.expire(`userChannels:${userId}`, 43200);
        await safeRedis(() => multi.exec(), `update userChannels:${userId}`);
      }
    }

    if (channelIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No channels found",
        data: { chat: null, userId },
      });
    }

    // Check authorization with Redis
    const authorizedChannelIds = new Set();
    const channelsToCheckInMongo = [];

    for (const channelId of channelIds) {
      const isAuthorized = await safeRedis(
        () => redisClient.sIsMember(`channelReceivers:${channelId}`, userId),
        `check channelReceivers:${channelId}`
      );

      if (isAuthorized) {
        authorizedChannelIds.add(channelId);
      } else {
        const isNotAllowed = await safeRedis(
          () => redisClient.sIsMember(`notAllowed:${channelId}`, userId),
          `check notAllowed:${channelId}`
        );
        console.log(`Channel ${channelId} notAllowed: ${isNotAllowed}`);
        if (!isNotAllowed) {
          channelsToCheckInMongo.push(channelId);
        }
      }
    }

    // Fallback to MongoDB
    if (channelsToCheckInMongo.length > 0) {
      const channels = await Channel.find({
        _id: { $in: channelsToCheckInMongo },
        participants: userId,
        blockedBy: { $ne: userId },
      }).lean();

      const multi = redisClient.multi();
      for (const channel of channels) {
        authorizedChannelIds.add(channel._id.toString());
        multi.sAdd(`channelReceivers:${channel._id}`, userId);
        multi.sAdd(`userChannels:${userId}`, channel._id.toString());
        multi.expire(`channelReceivers:${channel._id}`, 43200);
      }
      multi.expire(`userChannels:${userId}`, 43200);

      const unauthorizedChannels = channelsToCheckInMongo.filter(
        (id) => !channels.some((ch) => ch._id.toString() === id)
      );
      for (const channelId of unauthorizedChannels) {
        multi.sAdd(`notAllowed:${channelId}`, userId);
        multi.expire(`notAllowed:${channelId}`, 43200);
      }

      await safeRedis(
        () => multi.exec(),
        "update channel authorization caches"
      );
    }

    if (authorizedChannelIds.size === 0) {
      return res.status(200).json({
        success: true,
        message: "No authorized channels found",
        data: { chat: null, userId },
      });
    }

    // Fetch the latest chat for each authorized channel using aggregation
    const chats = await Chat.aggregate([
      {
        $match: {
          channelId: { $in: [...authorizedChannelIds] },
          isDeleted: { $ne: true },
        },
      },
      {
        $sort: { time: -1 }, // Sort by time descending
      },
      {
        $group: {
          _id: "$channelId", // Group by channelId
          chat: { $first: "$$ROOT" }, // Take the first document (latest) per group
        },
      },
      {
        $replaceRoot: { newRoot: "$chat" }, // Replace root with the chat document
      },
    ]);

    // Refresh TTLs
    const multi = redisClient.multi();
    for (const channelId of authorizedChannelIds) {
      multi.expire(`channelReceivers:${channelId}`, 43200);
      multi.expire(`notAllowed:${channelId}`, 43200);
    }
    multi.expire(`userChannels:${userId}`, 43200);
    await safeRedis(() => multi.exec(), "refresh TTLs");

    return res.status(200).json({
      success: true,
      message:
        chats.length > 0
          ? "Latest chats fetched successfully"
          : "No chats found",
      data: { chats, userId },
    });
  } catch (err) {
    console.error("Latest chat fetch error:", err);
    return res.status(500).json(formatError("Server error"));
  }
});

// Get a single chat by ID
router.get("/:id", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.uuid;

  try {
    // Fetch chat directly from MongoDB
    const chat = await Chat.findById(id).lean();

    if (!chat || chat.isDeleted) {
      return res.status(404).json(formatError("Chat not found"));
    }

    // Verify channel authorization
    const isAuthorized = await safeRedis(
      () => redisClient.sIsMember(`channelReceivers:${chat.channelId}`, userId),
      `check channelReceivers:${chat.channelId}`
    );

    if (!isAuthorized) {
      const isNotAllowed = await safeRedis(
        () => redisClient.sIsMember(`notAllowed:${chat.channelId}`, userId),
        `check notAllowed:${chat.channelId}`
      );
      if (isNotAllowed) {
        return res
          .status(403)
          .json(formatError("Channel not found or access denied"));
      }

      const channel = await Channel.findOne({
        _id: chat.channelId,
        participants: userId,
        blockedBy: { $ne: userId },
        // deletedBy: { $ne: userId },
      }).lean();

      if (!channel) {
        const multi = redisClient.multi();
        multi.sAdd(`notAllowed:${chat.channelId}`, userId);
        multi.expire(`notAllowed:${chat.channelId}`, 43200);
        await safeRedis(
          () => multi.exec(),
          `update notAllowed:${chat.channelId}`
        );
        return res
          .status(403)
          .json(formatError("Channel not found or access denied"));
      }

      const multi = redisClient.multi();
      multi.sAdd(`channelReceivers:${chat.channelId}`, userId);
      multi.sAdd(`userChannels:${userId}`, chat.channelId);
      multi.expire(`channelReceivers:${chat.channelId}`, 43200);
      multi.expire(`userChannels:${userId}`, 43200);
      await safeRedis(
        () => multi.exec(),
        `update channelReceivers:${chat.channelId}`
      );
    }

    return res.status(200).json({
      success: true,
      message: "Chat fetched successfully",
      data: { chat, userId },
    });
  } catch (err) {
    console.error("Chat fetch error:", err);
    return res.status(500).json(formatError("Server error"));
  }
});

// Get chats for a channel before a time - 60chats/req
router.get(
  "/",
  verifyJWT,
  [
    query("channelId").isString().notEmpty().withMessage("Channel ID required"),
    query("time")
      .optional()
      .isISO8601()
      .toDate()
      .withMessage("Invalid time format"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(formatError(errors.array()[0].msg));
    }

    const userId = req.user.uuid;
    const { channelId, time } = req.query;

    try {
      // Check Redis for channel authorization
      const isAuthorized = await safeRedis(
        () => redisClient.sIsMember(`channelReceivers:${channelId}`, userId),
        `check channelReceivers:${channelId}`
      );

      if (!isAuthorized) {
        const isNotAllowed = await safeRedis(
          () => redisClient.sIsMember(`notAllowed:${channelId}`, userId),
          `check notAllowed:${channelId}`
        );
        if (isNotAllowed) {
          return res
            .status(403)
            .json(formatError("Channel not found or access denied"));
        }

        const channel = await Channel.findOne({
          _id: channelId,
          participants: userId,
          blockedBy: { $ne: userId },
          // deletedBy: { $ne: userId },
        }).lean();

        if (!channel) {
          const multi = redisClient.multi();
          multi.sAdd(`notAllowed:${channelId}`, userId);
          multi.expire(`notAllowed:${channelId}`, 43200);
          await safeRedis(() => multi.exec(), `update notAllowed:${channelId}`);
          return res
            .status(403)
            .json(formatError("Channel not found or access denied"));
        }

        const multi = redisClient.multi();
        multi.sAdd(`channelReceivers:${channelId}`, userId);
        multi.sAdd(`userChannels:${userId}`, channelId);
        multi.expire(`channelReceivers:${channelId}`, 43200);
        multi.expire(`userChannels:${userId}`, 43200);
        await safeRedis(
          () => multi.exec(),
          `update channelReceivers:${channelId}`
        );
      }

      // Fetch chats directly from MongoDB
      const query = {
        channelId,
        isDeleted: { $ne: true },
      };
      if (time) {
        query.time = { $lte: new Date(time) };
      }

      const chats = await Chat.find(query).sort({ time: -1 }).limit(60).lean();

      return res.status(200).json({
        success: true,
        message: "Chats fetched successfully",
        data: { chats, userId },
      });
    } catch (err) {
      console.error("Chats fetch error:", err);
      return res.status(500).json(formatError("Server error"));
    }
  }
);

// Delete a chat
router.patch("/:id/delete", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.uuid;

  try {
    let chat = await Chat.findById(id);
    if (chat) {
      if (chat.from !== userId) {
        return res
          .status(403)
          .json(formatError("Only the sender can delete this chat"));
      }
      chat.isDeleted = true;
      await chat.save();
    } else {
      // If chat not found in MongoDB, mark it for deletion in Redis
      await safeRedis(
        () => redisClient.set(`chat:delete:${id}`, "true", { EX: 43200 }),
        `set pending delete for chat:${id}`
      );
    }

    return res.status(200).json({
      success: true,
      message: "Chat deleted successfully",
      data: { chatId: id },
    });
  } catch (err) {
    console.error("Chat delete error:", err);
    return res.status(500).json(formatError("Server error"));
  }
});

// React to a chat
router.post(
  "/:id/react",
  verifyJWT,
  [body("reaction").isString().notEmpty().withMessage("Reaction required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json(formatError(errors.array()[0].msg));

    const { id } = req.params;
    const { reaction } = req.body;
    const userId = req.user.uuid;

    try {
      let chat = await Chat.findById(id);
      if (chat) {
        const existingReaction = chat.reactedWith.find((r) => r.id === userId);
        if (existingReaction) {
          existingReaction.reactedWith = reaction;
        } else {
          chat.reactedWith.push({ id: userId, reactedWith: reaction });
        }
        await chat.save();
      } else {
        // If chat not found in MongoDB, store the reaction in Redis
        await safeRedis(
          () =>
            redisClient.set(
              `chat:reaction:${id}`,
              JSON.stringify({ userId, reaction }),
              { EX: 43200 }
            ),
          `set pending reaction for chat:${id}`
        );
      }

      return res.status(200).json({
        success: true,
        message: "Reaction added successfully",
        data: { chatId: id, reaction, userId },
      });
    } catch (err) {
      console.error("Chat react error:", err);
      return res.status(500).json(formatError("Server error"));
    }
  }
);

module.exports = router;
