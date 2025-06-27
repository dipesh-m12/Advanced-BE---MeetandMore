const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { body, query, param, validationResult } = require("express-validator");
const { Channel, ReadUpto } = require("../../models/chatModels");
const redis = require("redis");
const verifyJWT = require("../../middlewares/verifyJWT");

const readUptoRouter = express.Router();

// Initialize Redis client
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch((err) => {
  console.error("Redis connection error:", err.message);
});

// Safe Redis operation with error logging
async function safeRedis(fn, operation) {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error: ${operation}`, err);
    throw err;
  }
}

// Format error response
const formatError = (msg) => ({ success: false, message: msg, data: null });

readUptoRouter.use(verifyJWT);

// POST /readUpto/:id - Upsert ReadUpto for a user in a channel
readUptoRouter.post(
  "/:id",
  [
    param("id").isString().notEmpty().withMessage("Channel ID required"),
    body("lastMessageSeenId")
      .isString()
      .notEmpty()
      .withMessage("Last message seen ID required"),
    body("readUpto")
      .isISO8601()
      .toDate()
      .withMessage("Valid readUpto date required"),
  ],
  async (req, res) => {
    // Validate request inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(formatError(errors.array()[0].msg));
    }

    const { id: channelId } = req.params;
    const { lastMessageSeenId, readUpto } = req.body;
    const userId = req.user.uuid;
    try {
      // Upsert ReadUpto document
      const doc = await ReadUpto.findOneAndUpdate(
        { userId, channelId },
        {
          $set: { readUpto, lastMessageSeenId },
          $setOnInsert: { _id: uuidv4() },
        },
        { upsert: true, new: true, lean: true }
      );

      // Cache individual ReadUpto data
      await safeRedis(
        () =>
          redisClient.setEx(
            `readUpto:${channelId}:${userId}`,
            43200,
            JSON.stringify({
              readUpto: doc.readUpto,
              lastMessageSeenId: doc.lastMessageSeenId,
            })
          ),
        `cache readUpto:${channelId}:${userId}`
      );

      await safeRedis(
        () => redisClient.del(`readUpto:${channelId}`),
        `delete readUpto:${channelId}`
      );

      return res.status(200).json({
        success: true,
        message: "ReadUpto updated successfully",
        data: doc,
      });
    } catch (err) {
      console.error("ReadUpto upsert error:", err);
      return res.status(400).json(formatError(err.message || "Server error"));
    }
  }
);

// GET /readUpto - Get ReadUpto for multiple channels
readUptoRouter.get(
  "/",
  [
    body("channelIds")
      .isArray({ min: 1 })
      .withMessage("channelIds must be a non-empty array")
      .custom((arr) => arr.every((id) => typeof id === "string" && id.trim()))
      .withMessage("channelIds must contain valid strings"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(formatError(errors.array()[0].msg));
    }

    const { channelIds } = req.body;
    const userId = req.user.uuid;

    try {
      // Check Redis for channel-wide ReadUpto data
      const readUptoCacheKeys = channelIds.map((id) => `readUpto:${id}`);
      const cachedReadUptos = await safeRedis(
        () => redisClient.mGet(readUptoCacheKeys),
        "fetch readUpto caches"
      );

      const readUptoData = new Map();
      const missingChannelIds = [];
      channelIds.forEach((id, index) => {
        if (cachedReadUptos[index]) {
          const participantData = JSON.parse(cachedReadUptos[index]);
          readUptoData.set(id, participantData);
        } else {
          missingChannelIds.push(id);
        }
      });

      // Fetch missing channels and their ReadUpto data
      if (missingChannelIds.length > 0) {
        const channels = await Channel.find({ _id: { $in: missingChannelIds } })
          .lean()
          .select("participants blockedBy");
        // console.log("channels", channels);
        const validChannelIds = new Set(channels.map((c) => c._id.toString()));
        const accessibleChannelIds = missingChannelIds.filter((id) =>
          validChannelIds.has(id)
        );

        if (accessibleChannelIds.length === 0 && readUptoData.size === 0) {
          return res.status(400).json(formatError("No valid channels found"));
        }

        for (const { _id: channelId, participants, blockedBy } of channels) {
          // Filter out blocked participants
          const activeParticipants = participants.filter(
            (p) => !blockedBy.includes(p)
          );

          // Check Redis for individual ReadUpto data
          const participantCacheKeys = activeParticipants.map(
            (p) => `readUpto:${channelId}:${p}`
          );
          const cachedParticipantReadUptos = await safeRedis(
            () => redisClient.mGet(participantCacheKeys),
            `fetch readUpto for ${channelId} participants`
          );

          const participantData = [];
          const missingParticipants = [];

          activeParticipants.forEach((p, index) => {
            if (cachedParticipantReadUptos[index]) {
              participantData.push({
                userId: p,
                ...JSON.parse(cachedParticipantReadUptos[index]),
              });
            } else {
              missingParticipants.push(p);
            }
          });

          // Fetch missing ReadUpto from MongoDB
          if (missingParticipants.length > 0) {
            const readUptos = await ReadUpto.find({
              channelId,
              userId: { $in: missingParticipants },
            }).lean();
            // console.log("readupto", readUptos);

            const readUptoMap = new Map(
              readUptos.map((r) => [
                r.userId,
                {
                  readUpto: r.readUpto,
                  lastMessageSeenId: r.lastMessageSeenId,
                },
              ])
            );

            missingParticipants.forEach((p) => {
              participantData.push({
                userId: p,
                readUpto: readUptoMap.get(p)?.readUpto || null,
                lastMessageSeenId:
                  readUptoMap.get(p)?.lastMessageSeenId || null,
              });
            });
          }

          // Cache channel-wide and individual ReadUpto data
          const multi = redisClient.multi();
          multi.setEx(
            `readUpto:${channelId}`,
            43200,
            JSON.stringify(participantData)
          );
          participantData.forEach(({ userId, readUpto, lastMessageSeenId }) => {
            multi.setEx(
              `readUpto:${channelId}:${userId}`,
              43200,
              JSON.stringify({ readUpto, lastMessageSeenId })
            );
          });
          await safeRedis(
            () => multi.exec(),
            `cache readUpto for ${channelId} users`
          );

          readUptoData.set(channelId, participantData);
        }
      }

      const results = channelIds
        .filter((id) => readUptoData.has(id))
        .map((channelId) => ({
          channelId,
          participants: readUptoData.get(channelId),
        }));

      if (results.length === 0) {
        return res.status(400).json(formatError("No valid channels found"));
      }

      return res.status(200).json({
        success: true,
        message: "ReadUpto data fetched successfully",
        data: { results, userId },
      });
    } catch (err) {
      console.error("ReadUpto fetch error:", err);
      return res.status(500).json(formatError("Server error"));
    }
  }
);

module.exports = readUptoRouter;
