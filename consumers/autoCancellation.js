const { default: mongoose } = require("mongoose");
const Payment = require("../models/paymentModel");
const sendBulkEmails = require("../emailService/emailService");
const Razorpay = require("razorpay");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

module.exports = async function autoCancelAndRefund(paymentIds = []) {
  // Fetch only 'paid' payments and include user profile
  const payments = await Payment.find({
    _id: { $in: paymentIds },
    status: "paid",
    platform: "razorpay",
  }).populate("userId"); // Fetches associated Profile document

  const emailBatch = [];

  for (const payment of payments) {
    const user = payment.userId;

    if (!user || !payment.paymentId) {
      console.warn(
        `Skipping payment ${payment._id} - missing user or payment ID`
      );
      continue;
    }

    try {
      const refund = await razorpay.payments.refund(payment.paymentId);

      payment.status = "refunded";
      payment.refundId = refund.id;
      await payment.save();

      emailBatch.push({
        to: user.email,
        subject: "💸 Your Payment Has Been Refunded",
        templateName: "refund-notification",
        data: {
          name: user.name || "User",
          amount: (refund.amount / 100).toFixed(2),
          currency: refund.currency.toUpperCase(),
          refundId: refund.id,
        },
      });

      console.log(`✅ Refunded ${payment._id} for user ${user.email}`);
    } catch (err) {
      console.error(`❌ Refund failed for ${payment._id}: ${err.message}`);
    }
  }

  if (emailBatch.length > 0) {
    await sendBulkEmails(emailBatch);
    console.log(`📧 Sent ${emailBatch.length} refund emails`);
  }
};
