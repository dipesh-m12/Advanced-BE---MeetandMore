const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyJWT = require("../../middlewares/verifyJWT");
const { Channel } = require("../../models/chatModels");
const redis = require("redis");
const channeLRouter = express.Router();
const { getUserNames } = require("../../utils/profileCache");

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

// Utility function to format validation errors
const handleValidationErrors = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      data: null,
    });
  }
};

// Utility to store channel data in Redis
const storeChannelInRedis = async (channel, operationName) => {
  // Store channel data as stringified JSON in Redis with key `data:channelId`
  await safeRedis(
    () => redisClient.set(`data:${channel._id}`, JSON.stringify(channel)),
    `${operationName}: set data:${channel._id}`
  );
  // Set TTL of 12 hours (43200 seconds) to manage memory
  await safeRedis(
    () => redisClient.expire(`data:${channel._id}`, 43200),
    `${operationName}: expire data:${channel._id}`
  );
};

// Create a channel
channeLRouter.post(
  "/",
  verifyJWT,
  [
    body("type")
      .isIn(["one-2-one", "group-chat"])
      .withMessage("Type must be either 'one-2-one' or 'group-chat'"),
    body("participants")
      .isArray({ min: 1 })
      .withMessage("Participants must be a non-empty array of user IDs")
      .custom((value, { req }) => {
        const allParticipants = [...new Set([req.user.uuid, ...value])];
        if (allParticipants.length < 2) {
          throw new Error("At least two unique persons are required");
        }
        return true;
      }),
    body("chatName")
      .if(body("type").equals("group-chat"))
      .notEmpty()
      .withMessage("Chat name is required for group chat"),
  ],
  async (req, res) => {
    const validationError = handleValidationErrors(req, res);
    if (validationError) return validationError;

    try {
      const { type, participants, chatName } = req.body;
      const uuid = uuidv4();
      const createdBy = req.user.uuid;

      const newChannel = await Channel.create({
        _id: uuid,
        createdBy,
        participants: [...new Set([createdBy, ...participants])],
        type,
        chatName: type === "group-chat" ? chatName : undefined,
      });

      // Update Redis sets
      const multi = redisClient.multi();
      newChannel.participants.forEach((userId) => {
        multi.sAdd(`userChannels:${userId}`, uuid);
        multi.sAdd(`channelReceivers:${uuid}`, userId);
        multi.sRem(`notAllowed:${uuid}`, userId);
        multi.expire(`userChannels:${userId}`, 43200);
        multi.expire(`channelReceivers:${uuid}`, 43200);
      });
      multi.expire(`notAllowed:${uuid}`, 43200);
      await safeRedis(() => multi.exec(), "update Redis for new channel");

      // Store new channel data in Redis
      await storeChannelInRedis(newChannel, "create channel");

      res.status(201).json({
        success: true,
        message: "Channel created successfully",
        data: newChannel,
      });
    } catch (err) {
      console.error("Error creating channel:", err);
      res.status(500).json({
        success: false,
        message: "Server error while creating channel",
        data: null,
      });
    }
  }
);

// Get channels for the logged-in user
channeLRouter.get("/", verifyJWT, async (req, res) => {
  try {
    const userId = req.user.uuid;

    let channelIds = await safeRedis(
      () => redisClient.sMembers(`userChannels:${userId}`),
      "fetch userChannels"
    );

    let channels = [];
    const missingChannelIds = [];

    if (channelIds && channelIds.length > 0) {
      // Fetch all channel data in one mGet call
      const channelKeys = channelIds.map((id) => `data:${id}`);
      const channelData = await safeRedis(
        () => redisClient.mGet(channelKeys),
        "fetch multiple channel data"
      );

      channels = channelData
        .map((data, index) => {
          if (data) return JSON.parse(data);
          missingChannelIds.push(channelIds[index]);
          return null;
        })
        .filter((c) => c !== null);
    }

    if (
      missingChannelIds.length > 0 ||
      !channelIds ||
      channelIds.length === 0
    ) {
      const mongoChannels = await Channel.find({
        $or: [
          { _id: { $in: missingChannelIds } },
          { participants: userId, blockedBy: { $ne: userId } },
        ],
      })
        .sort({ updatedAt: -1 })
        .lean();
      channels = [...channels, ...mongoChannels];

      const multi = redisClient.multi();
      mongoChannels.forEach((channel) => {
        multi.set(`data:${channel._id}`, JSON.stringify(channel));
        multi.expire(`data:${channel._id}`, 43200);
        multi.sAdd(`userChannels:${userId}`, channel._id);
        multi.sAdd(`channelReceivers:${channel._id}`, userId);
        multi.sRem(`notAllowed:${channel._id}`, userId);
        multi.expire(`channelReceivers:${channel._id}`, 43200);
        multi.expire(`notAllowed:${channel._id}`, 43200);
      });
      multi.expire(`userChannels:${userId}`, 43200);
      await safeRedis(() => multi.exec(), "update Redis for channels");
    }

    channels = channels.filter(
      (channel) =>
        channel &&
        channel.participants.includes(userId) &&
        !channel.blockedBy.includes(userId)
    );

    const oneToOneUserIds = [];
    channels.forEach((channel) => {
      if (channel.type === "one-2-one") {
        const otherUserId = channel.participants.find((id) => id !== userId);
        if (otherUserId) oneToOneUserIds.push(otherUserId);
      }
    });

    const userNames = await getUserNames(oneToOneUserIds);

    const enrichedChannels = await Promise.all(
      channels.map(async (channel) => {
        const isOneToOne = channel.type === "one-2-one";
        const hasAnyBlock = channel.blockedBy && channel.blockedBy.length > 0;

        let displayName = channel.chatName;
        if (isOneToOne) {
          const otherUserId = channel.participants.find((id) => id !== userId);
          displayName = userNames.get(otherUserId) || otherUserId || "Unknown";
        }

        let onlineInfo = { online: false, noOfUsers: 0 };
        if (isOneToOne) {
          if (!hasAnyBlock) {
            const otherUserId = channel.participants.find(
              (id) => id !== userId
            );
            const isOnline = await safeRedis(
              () => redisClient.sIsMember("onlineUsers", otherUserId),
              `check onlineUsers for ${otherUserId}`
            );
            onlineInfo = { online: isOnline > 0, noOfUsers: isOnline ? 1 : 0 };
          }
        } else {
          const blockedSet = new Set(channel.blockedBy);
          const visibleParticipants = channel.participants.filter(
            (id) => !blockedSet.has(id)
          );
          const participantStatuses = await Promise.all(
            visibleParticipants.map((id) =>
              safeRedis(
                () => redisClient.sIsMember("onlineUsers", id),
                `check onlineUsers for ${id}`
              )
            )
          );
          const onlineCount = participantStatuses.filter(Boolean).length;
          onlineInfo = { online: onlineCount > 0, noOfUsers: onlineCount };
        }

        return { ...channel, displayName, online: onlineInfo };
      })
    );

    res.status(200).json({
      success: true,
      message: "Channels fetched successfully",
      data: { channels: enrichedChannels, userId },
    });
  } catch (err) {
    console.error("Error fetching channels:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching channels",
      data: null,
    });
  }
});

// Toggle block status -t
channeLRouter.patch("/:id/toggle_block", verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.uuid;

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
        data: null,
      });
    }
    if (!channel.participants.includes(userId)) {
      return res.status(403).json({
        success: false,
        message: "Only participants can block/unblock the channel",
        data: null,
      });
    }

    const isBlocked = channel.blockedBy.includes(userId);
    const multi = redisClient.multi();

    if (isBlocked) {
      // Unblock: Add to channelReceivers, userChannels, remove from notAllowed
      channel.blockedBy.pull(userId);
      multi.sAdd(`channelReceivers:${id}`, userId);
      multi.sAdd(`userChannels:${userId}`, id);
      multi.sRem(`notAllowed:${id}`, userId);
    } else {
      // Block: Remove from channelReceivers, userChannels, add to notAllowed
      channel.blockedBy.push(userId);
      multi.sRem(`channelReceivers:${id}`, userId);
      multi.sRem(`userChannels:${userId}`, id);
      multi.sAdd(`notAllowed:${id}`, userId);
    }

    await safeRedis(
      () => redisClient.del(`readUpto:${id}`),
      `delete readUpto:${id}`
    );

    multi.expire(`channelReceivers:${id}`, 43200);
    multi.expire(`userChannels:${userId}`, 43200);
    multi.expire(`notAllowed:${id}`, 43200);
    await safeRedis(() => multi.exec(), "update Redis for toggle block");

    await channel.save();
    await storeChannelInRedis(channel, "toggle block");

    res.status(200).json({
      success: true,
      message: `Channel ${isBlocked ? "unblocked" : "blocked"} successfully`,
      data: channel,
    });
  } catch (err) {
    console.error("Error toggling block status:", err);
    res.status(500).json({
      success: false,
      message: "Server error while toggling block status",
      data: null,
    });
  }
});

// Soft delete a channel
channeLRouter.patch("/:id/delete", verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.uuid;

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: "Channel not found",
        data: null,
      });
    }

    if (!channel.participants.includes(userId)) {
      return res.status(403).json({
        success: false,
        message: "Only participants can delete the channel",
        data: null,
      });
    }

    if (!channel.deletedBy.includes(userId)) {
      channel.deletedBy.push(userId);
      await channel.save();
    }

    // Update channel data in Redis after soft delete
    await storeChannelInRedis(channel, "soft delete");

    res.status(200).json({
      success: true,
      message: "Channel deleted successfully",
      data: channel,
    });
  } catch (err) {
    console.error("Error soft deleting channel:", err);
    res.status(500).json({
      success: false,
      message: "Server error while deleting channel",
      data: null,
    });
  }
});

// Update group chat name
channeLRouter.patch(
  "/:id/chatName",
  verifyJWT,
  [body("chatName").notEmpty().withMessage("Chat name is required")],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    try {
      const { id } = req.params;
      const { chatName } = req.body;
      const userId = req.user.uuid;

      const channel = await Channel.findById(id);

      if (!channel) {
        return res.status(404).json({
          success: false,
          message: "Channel not found",
          data: null,
        });
      }

      if (channel.type !== "group-chat") {
        return res.status(400).json({
          success: false,
          message: "Chat name can only be updated for group chats",
          data: null,
        });
      }

      if (!channel.participants.includes(userId)) {
        return res.status(403).json({
          success: false,
          message: "Only participants can update the group chat name",
          data: null,
        });
      }

      if (channel.blockedBy.includes(userId)) {
        return res.status(403).json({
          success: false,
          message: "Blocked users cannot update the chat name",
          data: null,
        });
      }

      channel.chatName = chatName;
      await channel.save();

      // Update channel data in Redis after chat name update
      await storeChannelInRedis(channel, "update chat name");

      res.status(200).json({
        success: true,
        message: "Chat name updated successfully",
        data: channel,
      });
    } catch (err) {
      console.error("Error updating chat name:", err);
      res.status(500).json({
        success: false,
        message: "Server error while updating chat name",
        data: null,
      });
    }
  }
);

// Invite participants to group chat -t
channeLRouter.post(
  "/:id/invite",
  verifyJWT,
  [
    body("userIds")
      .isArray({ min: 1 })
      .withMessage("userIds must be a non-empty array of UUIDs")
      .custom((value) => {
        // Validate each userId as a UUID
        const uuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!value.every((id) => uuidRegex.test(id))) {
          throw new Error("All userIds must be valid UUIDs");
        }
        return true;
      }),
  ],
  async (req, res) => {
    const validationError = handleValidationErrors(req, res);
    if (validationError) return validationError;

    try {
      const { id } = req.params;
      const { userIds } = req.body;
      const userId = req.user.uuid;

      const channel = await Channel.findById(id);
      if (!channel) {
        return res.status(404).json({
          success: false,
          message: "Channel not found",
          data: null,
        });
      }

      if (channel.type !== "group-chat") {
        return res.status(400).json({
          success: false,
          message: "Participants can only be invited to group chats",
          data: null,
        });
      }

      if (!channel.participants.includes(userId)) {
        return res.status(403).json({
          success: false,
          message: "Only existing participants can invite others",
          data: null,
        });
      }

      if (channel.blockedBy.includes(userId)) {
        return res.status(403).json({
          success: false,
          message: "Blocked users cannot invite other users",
          data: null,
        });
      }

      const newUsers = userIds.filter(
        (id) => !channel.participants.includes(id)
      );

      if (newUsers.length === 0) {
        return res.status(400).json({
          success: false,
          message: "All invited users are already in the group",
          data: null,
        });
      }

      const updatedParticipants = [...channel.participants, ...newUsers];
      channel.participants = updatedParticipants;
      await channel.save();

      // Update Redis sets for new participants
      const multi = redisClient.multi();
      newUsers.forEach((newUserId) => {
        multi.sAdd(`userChannels:${newUserId}`, id);
        multi.sAdd(`channelReceivers:${id}`, newUserId);
        multi.sRem(`notAllowed:${id}`, newUserId);
        multi.expire(`userChannels:${newUserId}`, 43200);
      });
      multi.expire(`channelReceivers:${id}`, 43200);
      multi.expire(`notAllowed:${id}`, 43200);
      await safeRedis(() => multi.exec(), "update Redis for invite");

      // Update channel data in Redis after inviting participants
      await storeChannelInRedis(channel, "invite participants");

      await safeRedis(
        () => redisClient.del(`readUpto:${id}`),
        `delete readUpto:${id}`
      );

      res.status(200).json({
        success: true,
        message: "Participants invited successfully",
        data: channel,
      });
    } catch (err) {
      console.error("Error inviting participants:", err);
      res.status(500).json({
        success: false,
        message: "Server error while inviting participants",
        data: null,
      });
    }
  }
);

module.exports = channeLRouter;
