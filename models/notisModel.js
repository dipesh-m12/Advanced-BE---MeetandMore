const mongoose = require("mongoose");

const NotificationsSchema = new mongoose.Schema(
  {
    _id: {
      type: String, // UUID
      required: true,
    },
    userId: {
      type: String,
      required: true,
      ref: "Profile",
    },
    type: {
      type: String,
      enum: ["message", "rateExp", "anotherDinner"],
      required: true,
    },
    message: {
      message: {
        type: String,
        required: true,
        trim: true,
      },
      value: {
        type: Number,
        required: true,
        default: 0,
      },
    },
    RateExp: {
      message: {
        type: String,
        required: function () {
          return this.type === "rateExp";
        },
        trim: true,
      },
      value: {
        type: Number,
        required: function () {
          return this.type === "rateExp";
        },
      },
    },
    Anotherdinner: {
      message: {
        type: String,
        required: function () {
          return this.type === "anotherDinner";
        },
        trim: true,
      },
      value: {
        type: Boolean,
        required: function () {
          return this.type === "anotherDinner";
        },
      },
    },
    Requiresaction: {
      type: Boolean,
      required: function () {
        return this.type === "rateExp" || this.type === "anotherDinner";
      },
      default: function () {
        return this.type === "rateExp" || this.type === "anotherDinner";
      },
    },
  },
  { timestamps: true }
);

// Indexes for efficient querying
NotificationsSchema.index({ userId: 1 }); // For fetching notifications by user
NotificationsSchema.index({ type: 1 }); // For filtering by notification type
NotificationsSchema.index({ createdAt: -1 }); // For sorting by recency
NotificationsSchema.index({ userId: 1, type: 1 });

module.exports = mongoose.model("Notifications", NotificationsSchema);
