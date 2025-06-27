const mongoose = require("mongoose");

const FeedbackSchema = new mongoose.Schema(
  {
    _id: {
      type: String, // <-- This is critical to allow UUIDs
      required: true,
    },
    from: {
      type: String, // user UUID
      required: true,
      ref: "Profile",
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    fromReportIssuePage: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "resolved"],
      default: "pending",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Feedback", FeedbackSchema);
