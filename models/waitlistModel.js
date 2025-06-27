const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const WaitlistSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: uuidv4,
    },
    userId: {
      type: String,
      ref: "Profile",
      required: true,
    },
    dateId: {
      type: String,
      ref: "EventDate",
      required: true,
    },
    paymentId: {
      type: String,
      ref: "Payment",
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["waiting", "confirmed", "canceled", "completed"],
      default: "waiting",
    },
    attendance: {
      type: Boolean,
      default: false, // New field for attendance tracking
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    latitude: {
      type: Number,
      default: null, // Store latitude when attendance is marked
    },
    longitude: {
      type: Number,
      default: null, // Store longitude when attendance is marked
    },
  },
  { timestamps: true }
);

// Compound index for efficient querying by date and status
WaitlistSchema.index({ dateId: 1, status: 1 });
// Unique index for userId and dateId to prevent duplicates
WaitlistSchema.index({ userId: 1, dateId: 1 }, { unique: true });
WaitlistSchema.index({ userId: 1, dateId: 1, paymentId: 1 });

WaitlistSchema.index({ userId: 1, status: 1 });
WaitlistSchema.index({ dateId: 1 });
module.exports = mongoose.model("Waitlist", WaitlistSchema);
