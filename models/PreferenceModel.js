const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const PreferenceSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    userId: { type: String, required: [true, "User ID is required"] },
    dateId: {
      type: String,
      required: [true, "Date ID is required"],
      ref: "EventDate",
    },
    dietaryRestriction: { type: String },
    enjoyFood: { type: String },
    willingToSpend: { type: String },
    idealDinnerTime: { type: String },
  },
  { timestamps: true }
);

PreferenceSchema.index({ userId: 1, dateId: 1 }, { unique: true });

const Preference = mongoose.model("Preference", PreferenceSchema);

module.exports = { Preference, PreferenceSchema };
