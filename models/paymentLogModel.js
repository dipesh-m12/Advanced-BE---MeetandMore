const mongoose = require("mongoose");

const paymentLogSchema = new mongoose.Schema({
  _id: { type: String, default: require("uuid").v4 },
  paymentId: { type: String, required: true }, // Razorpay paymentId
  userId: { type: String, required: true },
  dateId: { type: String, required: true },
  action: {
    type: String,
    enum: ["capture", "refund", "failure"],
    required: true,
  },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  status: {
    type: String,
    enum: ["success", "pending", "failed"],
    required: true,
  },
  razorpayResponse: { type: Object }, // Store Razorpay API response
  error: { type: String }, // Error message if failed
  createdAt: { type: Date, default: Date.now },
});

const PaymentLogs = mongoose.model("PaymentLogs", paymentLogSchema);
module.exports = PaymentLogs;
