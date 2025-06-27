const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const currencies = require("../utils/data");

const PaymentSchema = new mongoose.Schema(
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
    orderId: {
      type: String,
      required: true,
      unique: true,
    },
    paymentId: {
      type: String,
      unique: true,
      sparse: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      enum: currencies,
      required: true,
    },
    refundId: {
      type: String,
      unique: true,
      sparse: true,
    },
    status: {
      type: String,
      enum: ["created", "paid", "failed", "canceled", "refunded"],
      default: "created",
    },
    platform: {
      type: String,
      enum: ["razorpay", "stripe"],
      required: true,
      default: "razorpay",
    },
    couponCode: { type: String, sparse: true }, // Store used coupon code
    discountApplied: { type: Number, default: 0 }, // Store applied discount
    createdAt: {
      type: Date,
      default: Date.now,
    },
    dateId: {
      type: String,
      ref: "EventDate",
      required: true, // Ensure dateId is provided
    },
  },
  { timestamps: true }
);

// Add compound index for userId and createdAt
PaymentSchema.index({ userId: 1, createdAt: -1 });
PaymentSchema.index({ _id: 1, status: 1 });
module.exports = mongoose.model("Payment", PaymentSchema);
