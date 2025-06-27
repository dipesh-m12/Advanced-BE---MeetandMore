// models/ChatModels.js

const mongoose = require("mongoose");

// 1. Channel Schema
const ChannelSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // UUID
    createdBy: { type: String, ref: "User" },
    blockedBy: [{ type: String, ref: "User" }],
    deletedBy: [{ type: String, ref: "User" }],
    chatName: {
      type: String,
      required: function () {
        return this.type === "group-chat";
      },
    },
    type: { type: String, enum: ["one-2-one", "group-chat"], required: true },
    participants: [{ type: String, ref: "User", required: true }],
  },
  { timestamps: true }
);

// Channel Indexes (consolidated, no duplicates)
ChannelSchema.index({ participants: 1 }); // For finding channels by user
ChannelSchema.index({ blockedBy: 1 }); // For filtering blocked users
ChannelSchema.index({ deletedBy: 1 }); // For filtering deleted channels
ChannelSchema.index({ updatedAt: -1 }); // For sorting by recency
ChannelSchema.index(
  { participants: 1, blockedBy: 1, deletedBy: 1 },
  {
    partialFilterExpression: { blockedBy: { $ne: [] }, deletedBy: { $ne: [] } },
  }
); // Compound index for access control queries

// 2. Chat Schema
const ChatSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // UUID
    channelId: { type: String, ref: "Channel", required: true },
    isDeleted: { type: Boolean, default: false },
    type: { type: String, enum: ["message", "media"], required: true },

    from: { type: String, ref: "User", required: true },

    replyTo: { type: String, ref: "Chat" },
    reactedWith: [
      {
        id: { type: String, ref: "User" },
        reactedWith: { type: String }, // emoji or reaction
      },
    ],

    media: {
      type: String,
      required: function () {
        return this.type === "media";
      },
    }, // if type = media
    mediaType: {
      type: String,
      enum: ["image", "video", "file"],
      required: function () {
        return this.type === "media";
      },
    },
    message: {
      type: String,
      trim: true,
      required: function () {
        return this.type === "message";
      },
    }, // if type = message

    time: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Chat Indexes (consolidated, no duplicates)
ChatSchema.index({ channelId: 1, isDeleted: 1, time: -1 }); // For fetching chats by channel with time sorting
ChatSchema.index({ from: 1 }); // For filtering by sender in delete route
ChatSchema.index({ message: "text" }); // For text search

// 3. ReadUpto Schema
const ReadUptoSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // UUID
    userId: { type: String, ref: "User", required: true },
    channelId: { type: String, ref: "Channel", required: true },
    readUpto: { type: Date, default: Date.now },
    lastMessageSeenId: { type: String, ref: "Chat" },
  },
  { timestamps: true }
);

// ReadUpto Indexes (consolidated, no duplicates)
ReadUptoSchema.index({ userId: 1, channelId: 1 }, { unique: true }); // For upsert operations
ReadUptoSchema.index({ channelId: 1 }); // For bulk fetching by channel

module.exports = {
  Channel: mongoose.model("Channel", ChannelSchema),
  Chat: mongoose.model("Chat", ChatSchema),
  ReadUpto: mongoose.model("ReadUpto", ReadUptoSchema),
};
