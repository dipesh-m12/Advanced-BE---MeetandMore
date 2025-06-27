const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const TeamSchema = new mongoose.Schema(
  {
    _id: {
      type: String, // <-- This is critical to allow UUIDs
      required: true,
      default: uuidv4,
    },
    dateId: { type: String, required: true },
    members: [
      {
        userId: { type: String, required: true },
        gender: { type: String, required: true },
        dob: { type: Date, required: true }, // Add dob field
      },
    ],
    status: { type: String, enum: ["formed", "incomplete"], default: "formed" },
  },
  { timestamps: true }
);
TeamSchema.index({ dateId: 1 });
module.exports = mongoose.model("Team", TeamSchema);
