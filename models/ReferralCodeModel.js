const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const ReferralSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    userId: {
      type: String,
      ref: "Profile",
      required: function () {
        return this.type === "standard";
      },
    },
    code: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ["standard", "influencer", "special"],
      required: true,
    },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    usageCount: { type: Number, default: 0 },
    rewardAfterUsages: {
      type: Number,
      default: function () {
        return this.type === "standard" ? 5 : undefined;
      },
      required: function () {
        return this.type === "standard";
      },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ReferralSchema.index({ userId: 1, status: 1 });
ReferralSchema.index({ code: 1, status: 1 });
// ReferralSchema.index({ code: 1 });

module.exports = mongoose.model("Referral", ReferralSchema);
