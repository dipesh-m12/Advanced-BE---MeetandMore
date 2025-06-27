const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const EventDateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    city: {
      type: String,
      ref: "VenueCity",
      required: [true, "City is required"],
    },
    date: {
      type: Date, // Refers to native JavaScript Date
      required: [true, "Date is required"],
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

EventDateSchema.index({ city: 1, date: 1 }, { unique: true });
EventDateSchema.index({ date: 1 });
EventDateSchema.index({ city: 1 });

const EventDate = mongoose.model("EventDate", EventDateSchema);

module.exports = { EventDate, EventDateSchema };
