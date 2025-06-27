const mongoose = require("mongoose");

const UserDetailsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    userId: {
      type: String,
      required: true,
      unique: true,
      ref: "Profile",
    },
    // Updated schema: only WorkingIndustry is required, others optional
    PartyPersonality: { type: String },
    Guide: { type: String },
    Jam: { type: String },
    LifeSummarizer: { type: String },
    Icebreaker: { type: String },
    IdealDinner: { type: String },
    Extrovert: { type: Number },
    DeepConnections: { type: Number },
    Dark: { type: Number },
    Doer: { type: Number },
    EasilyOffended: { type: Number },
    Strongly: { type: Number },
    WorkingIndustry: { type: String, required: true },
    RelationshipStatus: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserDetails", UserDetailsSchema);
