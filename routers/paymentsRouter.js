const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Profile = require("../models/authModel");
const verifyJWT = require("../middlewares/verifyJWT");
const Payment = require("../models/paymentModel");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { body, validationResult, query, param } = require("express-validator");
const paymentsRouter = express.Router();
const { v4: uuidv4 } = require("uuid");
const Referral = require("../models/ReferralCodeModel");
const Reward = require("../models/RewardModel"); // Import new Reward model
const currencies = require("../utils/data");
const { sendMessageToKafka } = require("../utils/kafka");
const { EventDate } = require("../models/DateModel");
const { VenueCity, Venue } = require("../models/eventModel");
const { DateTime } = require("luxon");
const Waitlist = require("../models/waitlistModel");
const mongoose = require("mongoose");
const PaymentLogs = require("../models/paymentLogModel");

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("Razorpay credentials missing in environment variables");
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// POST /api/payments/webhook
paymentsRouter.post(
  "/webhook/razorpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        throw new Error(
          "req.body is not a Buffer, middleware interference detected"
        );
      }
      const signature = req.headers["x-razorpay-signature"];
      const generatedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(req.body)
        .digest("hex");

      if (signature !== generatedSignature) {
        console.error("Invalid webhook signature:", {
          signature,
          generatedSignature,
        });
        return res.status(400).json({
          success: false,
          message: "Invalid webhook signature",
          data: null,
        });
      }

      const event = JSON.parse(req.body.toString("utf8"));
      const paymentEntity = event.payload.payment.entity;

      if (event.event === "payment.captured") {
        const { order_id, id: payment_id } = paymentEntity;
        const payment = await Payment.findOne({
          orderId: order_id,
          platform: "razorpay",
        });
        if (!payment) {
          console.error("Payment not found for order_id:", order_id);
          return res.status(404).json({
            success: false,
            message: "Payment not found",
            data: null,
          });
        }

        // Log capture
        await PaymentLogs.create({
          paymentId: payment_id,
          userId: payment.userId,
          dateId: payment.dateId,
          action: "capture",
          amount: payment.amount,
          currency: payment.currency,
          status: "success",
          razorpayResponse: paymentEntity,
        });

        // Update payment status
        payment.paymentId = payment_id;
        payment.status = "paid";
        await payment.save();

        // Check if payment is after 10 PM Friday
        const eventDate = await EventDate.findById(payment.dateId).lean();
        if (!eventDate) {
          console.error("Event date not found:", payment.dateId);
          return res.status(404).json({
            success: false,
            message: "Event date not found",
            data: null,
          });
        }
        const city = await VenueCity.findById(eventDate.city)
          .select("timezone")
          .lean();
        if (!city) {
          console.error("City not found:", eventDate.city);
          return res.status(404).json({
            success: false,
            message: "City not found",
            data: null,
          });
        }

        const now = DateTime.now().setZone(city.timezone);
        const eventLocal = DateTime.fromJSDate(eventDate.date, {
          zone: "utc",
        }).setZone(city.timezone);
        const fridayBeforeEvent = eventLocal
          .startOf("week")
          .plus({ days: 5, hours: 22 });
        const isLatePayment = now > fridayBeforeEvent;

        const queueName = isLatePayment ? "late-payment" : "payment-success";
        await sendMessageToKafka(queueName, {
          paymentId: payment._id,
          userId: payment.userId,
          dateId: payment.dateId,
          amount: payment.amount,
          currency: payment.currency,
          payment_id,
          order_id,
        });

        return res.status(200).json({
          success: true,
          message: `Payment verified and sent to ${queueName} queue`,
          data: null,
        });
      } else if (event.event === "payment.failed") {
        const { id: order_id } = event.payload.order.entity;
        const payment = await Payment.findOneAndUpdate(
          { orderId: order_id, platform: "razorpay" },
          { status: "canceled" },
          { new: true }
        );
        if (payment) {
          await PaymentLogs.create({
            paymentId: paymentEntity.id,
            userId: payment.userId,
            dateId: payment.dateId,
            action: "failure",
            amount: payment.amount,
            currency: payment.currency,
            status: "failed",
            razorpayResponse: paymentEntity,
            error: "Payment failed",
          });
        } else {
          console.error("Payment not found for order_id:", order_id);
        }
        return res.status(200).json({
          success: true,
          message: "Order expired, payment canceled",
          data: null,
        });
      } else if (event.event === "payment.refunded") {
        const { id: payment_id, refund_id } = paymentEntity;
        const payment = await Payment.findOneAndUpdate(
          { paymentId: payment_id, platform: "razorpay" },
          { status: "refunded", refundId: refund_id },
          { new: true }
        );
        if (payment) {
          await PaymentLogs.create({
            paymentId: payment_id,
            userId: payment.userId,
            dateId: payment.dateId,
            action: "refund",
            amount: paymentEntity.amount_refunded,
            currency: payment.currency,
            status: "success",
            razorpayResponse: paymentEntity,
          });

          const waitlist = await Waitlist.findOneAndUpdate(
            { paymentId: payment._id, dateId: payment.dateId },
            { status: "canceled" },
            { new: true }
          );

          if (waitlist) {
            const eventDate = await EventDate.findById(payment.dateId).lean();
            const city = await VenueCity.findById(eventDate.city)
              .select("city_name timezone")
              .lean();
            const formattedDate = DateTime.fromJSDate(eventDate.date, {
              zone: "utc",
            })
              .setZone(city.timezone)
              .toLocaleString(DateTime.DATETIME_MED);

            const user = await Profile.findById(payment.userId)
              .select("email name pushtoken")
              .lean();

            if (user) {
              await sendMessageToKafka("bulk-email", {
                to: user.email,
                subject: "Meet and More - Refund Confirmation",
                templateName: "refund-notification",
                data: sanitizeData({
                  name: user.name || "User",
                  amount: payment.amount,
                  currency: payment.currency,
                  refundId: refund_id,
                  eventDate: formattedDate,
                  city: city.city_name,
                }),
              });

              if (user.pushtoken) {
                await sendMessageToKafka("notification-batch", {
                  tokens: [user.pushtoken],
                  title: "Refund Processed",
                  body: `Your booking for the event in ${city.city_name} on ${formattedDate} was refunded.`,
                  data: { refundId: refund_id, dateId: payment.dateId },
                });
              }

              await Notifications.create({
                _id: uuidv4(),
                userId: payment.userId,
                type: "message",
                message: {
                  message: `Your booking for the event in ${city.city_name} on ${formattedDate} has been refunded.`,
                  value: 0,
                },
                Requiresaction: false,
              });
            }
          }
        } else {
          console.error("Payment not found for payment_id:", payment_id);
        }
        return res.status(200).json({
          success: true,
          message: "Refund processed",
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Webhook received but no action taken",
        data: null,
      });
    } catch (err) {
      console.error("Webhook error:", err.message);
      return res.status(400).json({
        success: false,
        message:
          "Webhook processing failed: " + (err.message || "Unknown error"),
        data: null,
      });
    }
  }
);

paymentsRouter.use(express.json());

// POST /api/payments/create-order
paymentsRouter.post(
  "/create-order/razorpay",
  verifyJWT,
  [
    body("amount").isFloat({ min: 1 }).withMessage("Amount must be at least 1"),
    body("currency")
      .isString()
      .isIn(currencies)
      .withMessage("Currency must be one of INR, USD, CAD, GBP, EUR"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { amount, currency } = req.body;
    const userId = req.user.uuid;
    try {
      const order = await razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency,
        receipt: `receipt_${Date.now()}`,
      });

      const payment = new Payment({
        _id: uuidv4(),
        userId,
        orderId: order.id,
        amount,
        currency,
        status: "created",
        platform: "razorpay",
      });
      await payment.save();
      return res.status(200).json({
        success: true,
        message: "Order created",
        data: {
          orderId: order.id,
          amount: amount,
          currency: order.currency,
          key: process.env.RAZORPAY_KEY_ID,
        },
      });
    } catch (err) {
      console.error("Error creating order:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create order: " + (err.message || "Unknown error"),
        data: null,
      });
    }
  }
);

// POST /api/payments/create-order-with-coupon/razorpay
paymentsRouter.post(
  "/create-order-with-coupon/razorpay",
  verifyJWT,
  [
    body("amount").isFloat({ min: 1 }).withMessage("Amount must be at least 1"),
    body("currency")
      .isString()
      .isIn(currencies)
      .withMessage("Currency must be one of INR, USD, CAD, GBP, EUR , etc."),
    body("couponCode")
      .optional()
      .isString()
      .withMessage("Coupon code must be a string"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { amount, currency, couponCode } = req.body;
    const userId = req.user.uuid;
    let finalAmount = amount;
    let discountApplied = 0;

    try {
      if (couponCode) {
        const referral = await Referral.findOne({
          code: couponCode,
          status: "active",
        });
        if (!referral)
          return res.status(400).json({
            success: false,
            message: "Invalid or inactive coupon code",
            data: null,
          });
        if (referral.userId && referral.userId === userId)
          return res.status(400).json({
            success: false,
            message: "Cannot use your own coupon code",
            data: null,
          });
        if (referral.type === "special" && referral.usageCount >= 1)
          return res.status(400).json({
            success: false,
            message: "Special code has already been used",
            data: null,
          });

        const reward = await Reward.findOne({ referralType: referral.type });
        if (!reward)
          return res.status(500).json({
            success: false,
            message: "Reward configuration not found",
            data: null,
          });

        discountApplied = reward[currency]?.userReward || 0;
        finalAmount = Math.max(1, amount - discountApplied);
      }

      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100),
        currency,
        receipt: `receipt_${Date.now()}`,
      });

      const payment = new Payment({
        _id: uuidv4(),
        userId,
        orderId: order.id,
        amount: finalAmount,
        currency,
        status: "created",
        platform: "razorpay",
        couponCode: couponCode || null,
        discountApplied,
      });
      await payment.save();

      return res.status(200).json({
        success: true,
        message: "Order created",
        data: {
          orderId: order.id,
          amount: amount,
          currency: order.currency,
          key: process.env.RAZORPAY_KEY_ID,
          discountApplied,
        },
      });
    } catch (err) {
      console.error("Error creating order:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create order: " + (err.message || "Unknown error"),
        data: null,
      });
    }
  }
);

// POST /api/payments/refund
paymentsRouter.post(
  "/refund/razorpay",
  verifyJWT,
  [body("orderId").notEmpty().withMessage("Order ID is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { orderId } = req.body;
    const userId = req.user.uuid;
    let payment = null;
    try {
      payment = await Payment.findOne({
        orderId,
        userId,
        platform: "razorpay",
        status: "paid",
      });
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: "Payment not found or not eligible for refund",
          data: null,
        });
      }

      // Fetch waitlist for dateId
      const waitlist = await Waitlist.findOne({ paymentId: payment._id });
      if (!waitlist || !waitlist.dateId) {
        return res.status(400).json({
          success: false,
          message: "Waitlist entry or dateId not found for this payment",
          data: null,
        });
      }

      // Await the refund operation
      const refund = await razorpay.payments.refund(payment.paymentId, {
        amount: Math.round(payment.amount * 100),
      });

      // Update the payment with refundId and status
      const updatedPayment = await Payment.findOneAndUpdate(
        { orderId },
        { status: "refunded", refundId: refund.id },
        { new: true }
      );

      // Log successful refund
      await PaymentLogs.create([
        {
          _id: uuidv4(),
          paymentId: payment.paymentId,
          userId,
          dateId: waitlist.dateId,
          action: "refund",
          status: "success",
          amount: payment.amount,
          currency: payment.currency,
          refundId: refund.id,
          createdAt: new Date(),
        },
      ]);

      return res.status(200).json({
        success: true,
        message: "Refund processed",
        data: { refundId: refund.id },
      });
    } catch (err) {
      console.error("Error processing refund:", err.message);

      // Log server error if payment exists
      if (payment) {
        const waitlist = await Waitlist.findOne({ paymentId: payment._id });
        if (waitlist && waitlist.dateId) {
          await PaymentLogs.create([
            {
              _id: uuidv4(),
              paymentId: payment.paymentId,
              userId,
              dateId: waitlist.dateId,
              action: "refund",
              status: "failed",
              amount: payment.amount,
              currency: payment.currency,
              error: err.message || "Unknown error",
              createdAt: new Date(),
            },
          ]);
        }
      }

      return res.status(500).json({
        success: false,
        message:
          "Failed to process refund: " + (err.message || "Unknown error"),
        data: null,
      });
    }
  }
);

// GET /api/payments
paymentsRouter.get(
  "/",
  verifyJWT,
  [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: [] });

    try {
      const userId = req.user.uuid;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const payments = await Payment.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
      const total = await Payment.countDocuments({ userId });
      return res.status(200).json({
        success: true,
        message: "User payments fetched successfully",
        data: payments,
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error("Error fetching payments:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch payments",
        data: [],
      });
    }
  }
);

// GET /api/payments/check-payment-status/:orderId
paymentsRouter.get(
  "/check-payment-status/:orderId",
  verifyJWT,
  async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.uuid;
    try {
      const payment = await Payment.findOne({
        orderId,
        userId,
        platform: "razorpay",
      });
      if (!payment) {
        return res
          .status(404)
          .json({ success: false, message: "Payment not found" });
      }

      // If already paid, return immediately
      if (payment.status === "paid") {
        return res.status(200).json({
          success: true,
          message: "Payment already marked as paid",
          data: payment,
        });
      }

      // If already refunded, return immediately
      if (payment.status === "refunded") {
        return res.status(200).json({
          success: true,
          message: "Payment already marked as refunded",
          data: payment,
        });
      }

      // Fetch Razorpay order and payment status
      const razorpayOrder = await razorpay.orders.fetch(orderId);
      const payments = await razorpay.orders.fetchPayments(orderId);

      if (payments.items.length > 0) {
        const razorpayPayment = payments.items[0];
        const razorpayStatus = razorpayPayment.status;

        // If Razorpay status is "captured"
        if (razorpayStatus === "captured") {
          // If database status is "created", handle as a missed webhook
          if (payment.status === "created") {
            // Update payment status to "paid"
            const updatedPayment = await Payment.findOneAndUpdate(
              { orderId, platform: "razorpay" },
              { status: "paid", paymentId: razorpayPayment.id },
              { new: true }
            );

            // Log the capture in PaymentLogs
            await PaymentLogs.create({
              paymentId: razorpayPayment.id,
              userId: payment.userId,
              dateId: payment.dateId,
              action: "capture",
              amount: payment.amount,
              currency: payment.currency,
              status: "success",
              razorpayResponse: razorpayPayment,
            });

            // Fetch event and city for timing check
            const eventDate = await EventDate.findById(payment.dateId).lean();
            if (!eventDate) {
              console.error("Event date not found:", payment.dateId);
              return res.status(404).json({
                success: false,
                message: "Event date not found",
                data: null,
              });
            }

            const city = await VenueCity.findById(eventDate.city)
              .select("timezone")
              .lean();
            if (!city) {
              console.error("City not found:", eventDate.city);
              return res.status(404).json({
                success: false,
                message: "City not found",
                data: null,
              });
            }

            // Check if payment is after 10 PM Friday
            const now = DateTime.now().setZone(city.timezone);
            const eventLocal = DateTime.fromJSDate(eventDate.date, {
              zone: "utc",
            }).setZone(city.timezone);
            const fridayBeforeEvent = eventLocal
              .startOf("week")
              .plus({ days: 5, hours: 22 }); // Friday 10 PM
            const isLatePayment = now > fridayBeforeEvent;

            const queueName = isLatePayment
              ? "late-payment"
              : "payment-success";
            await sendMessageToKafka(queueName, {
              paymentId: updatedPayment._id,
              userId: updatedPayment.userId,
              dateId: updatedPayment.dateId,
              amount: updatedPayment.amount,
              currency: updatedPayment.currency,
              payment_id: razorpayPayment.id,
              order_id: orderId,
            });

            return res.status(200).json({
              success: true,
              message: `Payment status updated to paid and sent to ${queueName} queue`,
              data: updatedPayment,
            });
          } else {
            // If database status is not "created", just update to "paid"
            const updatedPayment = await Payment.findOneAndUpdate(
              { orderId, platform: "razorpay" },
              { status: "paid", paymentId: razorpayPayment.id },
              { new: true }
            );

            return res.status(200).json({
              success: true,
              message: "Payment status updated to paid",
              data: updatedPayment,
            });
          }
        }

        // If Razorpay status is "refunded"
        if (razorpayStatus === "refunded") {
          const updatedPayment = await Payment.findOneAndUpdate(
            { orderId, platform: "razorpay" },
            {
              status: "refunded",
              paymentId: razorpayPayment.id,
              refundId: razorpayPayment.refund_id || "unknown",
            },
            { new: true }
          );

          // Log the refund in PaymentLogs
          await PaymentLogs.create({
            paymentId: razorpayPayment.id,
            userId: payment.userId,
            dateId: payment.dateId,
            action: "refund",
            amount: razorpayPayment.amount_refunded || payment.amount,
            currency: payment.currency,
            status: "success",
            razorpayResponse: razorpayPayment,
          });

          return res.status(200).json({
            success: true,
            message: "Payment status updated to refunded",
            data: updatedPayment,
          });
        }

        // If Razorpay status is "failed"
        if (razorpayStatus === "failed") {
          const updatedPayment = await Payment.findOneAndUpdate(
            { orderId, platform: "razorpay" },
            { status: "canceled", paymentId: razorpayPayment.id },
            { new: true }
          );

          // Log the failure in PaymentLogs
          await PaymentLogs.create({
            paymentId: razorpayPayment.id,
            userId: payment.userId,
            dateId: payment.dateId,
            action: "failure",
            amount: payment.amount,
            currency: payment.currency,
            status: "failed",
            razorpayResponse: razorpayPayment,
            error: "Payment failed",
          });

          return res.status(200).json({
            success: true,
            message: "Payment status updated to canceled due to failure",
            data: updatedPayment,
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Payment not captured yet",
        data: payment,
      });
    } catch (err) {
      console.error("Error checking payment status:", err.message);
      return res
        .status(500)
        .json({ success: false, message: "Failed to check payment status" });
    }
  }
);

// POST /api/payments/refund/noshow - fake
paymentsRouter.get(
  "/refund/noshow/:paymentId",
  [param("paymentId").notEmpty().withMessage("Payment ID is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Refund Error - Meet and More</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .error { background-color: #fee2e2; border: 1px solid #f87171; color: #991b1b; padding: 15px; border-radius: 6px; }
          </style>
        </head>
        <body>
          <h2>❌ Refund Error</h2>
          <div class="error">${errors.array()[0].msg}</div>
        </body>
        </html>
      `);
    }

    const { paymentId } = req.params;
    const session = await mongoose.startSession();

    try {
      let result = null;

      await session.withTransaction(async () => {
        // Find the payment using paymentId
        const payment = await Payment.findOne({
          paymentId,
          status: "paid",
        }).session(session);

        if (
          !payment ||
          !payment.userId ||
          !payment.amount ||
          !payment.currency
        ) {
          result = {
            success: false,
            message: "Payment not found or missing required fields",
            data: null,
          };
          return;
        }
        // Find the waitlist entry using the payment's _id (stored as paymentId in Waitlist)
        const waitlist = await Waitlist.findOne({
          paymentId: payment._id,
          status: "completed",
        }).session(session);

        if (!waitlist || !waitlist.dateId) {
          result = {
            success: false,
            message: "Waitlist entry not found or missing dateId",
            data: null,
          };
          return;
        }

        // Generate a no-show refund ID
        const refundId = `noshow_${uuidv4()}`;

        // Update the payment with refundId and status
        const updatedPayment = await Payment.findOneAndUpdate(
          { paymentId },
          { status: "refunded", refundId },
          { new: true, session }
        );

        result = {
          success: true,
          message: "Payment successfully marked as refunded!",
          data: { refundId, paymentId },
        };

        // Log successful refund
        await PaymentLogs.create(
          [
            {
              _id: uuidv4(),
              paymentId,
              userId: payment.userId,
              dateId: waitlist.dateId,
              action: "refund",
              status: "success",
              amount: payment.amount,
              currency: payment.currency,
              refundId,
              createdAt: new Date(),
            },
          ],
          { session }
        );
      });

      // Return HTML response based on result
      if (result.success) {
        return res.status(200).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Refund Processed - Meet and More</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { 
                font-family: Arial, sans-serif; 
                max-width: 600px; 
                margin: 50px auto; 
                padding: 20px; 
                background-color: #f8f9fa; 
              }
              .container { 
                background-color: white; 
                padding: 30px; 
                border-radius: 8px; 
                box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
              }
              .success { 
                background-color: #d1fae5; 
                border: 1px solid #10b981; 
                color: #065f46; 
                padding: 15px; 
                border-radius: 6px; 
                margin: 20px 0;
              }
              .info { 
                background-color: #f0f9ff; 
                border: 1px solid #0ea5e9; 
                color: #0c4a6e; 
                padding: 15px; 
                border-radius: 6px; 
                margin: 20px 0;
              }
              .code { 
                background-color: #f1f5f9; 
                padding: 8px 12px; 
                border-radius: 4px; 
                font-family: monospace; 
                font-size: 14px;
              }
              h2 { color: #1f2937; }
              .timestamp { color: #6b7280; font-size: 14px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h2>✅ No-Show Refund Processed Successfully</h2>
              
              <div class="success">
                <strong>Success!</strong> ${result.message}
              </div>
              
              <div class="info">
                <p><strong>Refund Details:</strong></p>
                <ul>
                  <li><strong>Payment ID:</strong> <span class="code">${paymentId}</span></li>
                  <li><strong>Refund ID:</strong> <span class="code">${
                    result.data.refundId
                  }</span></li>
                  <li><strong>Status:</strong> <span style="color: #10b981; font-weight: bold;">REFUNDED</span></li>
                  <li><strong>Processed At:</strong> ${new Date().toLocaleString()}</li>
                </ul>
              </div>
              
              <p class="timestamp">
                This refund has been automatically processed through the Meet and More admin system.
              </p>
              
              <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
              <p style="font-size: 12px; color: #6b7280; text-align: center;">
                © 2025 Meet and More. All rights reserved.
              </p>
            </div>
          </body>
          </html>
        `);
      } else {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Refund Failed - Meet and More</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { 
                font-family: Arial, sans-serif; 
                max-width: 600px; 
                margin: 50px auto; 
                padding: 20px; 
                background-color: #f8f9fa; 
              }
              .container { 
                background-color: white; 
                padding: 30px; 
                border-radius: 8px; 
                box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
              }
              .error { 
                background-color: #fee2e2; 
                border: 1px solid #f87171; 
                color: #991b1b; 
                padding: 15px; 
                border-radius: 6px; 
                margin: 20px 0;
              }
              .info { 
                background-color: #f0f9ff; 
                border: 1px solid #0ea5e9; 
                color: #0c4a6e; 
                padding: 15px; 
                border-radius: 6px; 
                margin: 20px 0;
              }
              h2 { color: #1f2937; }
            </style>
          </head>
          <body>
            <div class="container">
              <h2>❌ Refund Processing Failed</h2>
              
              <div class="error">
                <strong>Error:</strong> ${result.message}
              </div>
              
              <div class="info">
                <p><strong>Payment ID:</strong> ${paymentId}</p>
                <p><strong>Attempted At:</strong> ${new Date().toLocaleString()}</p>
              </div>
              
              <p>Please check the payment status manually or contact the development team.</p>
              
              <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
              <p style="font-size: 12px; color: #6b7280; text-align: center;">
                © 2025 Meet and More. All rights reserved.
              </p>
            </div>
          </body>
          </html>
        `);
      }
    } catch (err) {
      console.error("Error processing no-show refund:", err.message);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Server Error - Meet and More</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              max-width: 600px; 
              margin: 50px auto; 
              padding: 20px; 
              background-color: #f8f9fa; 
            }
            .container { 
              background-color: white; 
              padding: 30px; 
              border-radius: 8px; 
              box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
            }
            .error { 
              background-color: #fee2e2; 
              border: 1px solid #f87171; 
              color: #991b1b; 
              padding: 15px; 
              border-radius: 6px; 
              margin: 20px 0;
            }
            h2 { color: #1f2937; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>⚠️ Server Error</h2>
            
            <div class="error">
              <strong>Technical Error:</strong> Failed to process no-show refund
              <br><small>${err.message || "Unknown error occurred"}</small>
            </div>
            
            <p>Please try again later or contact the technical team.</p>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
            <p style="font-size: 12px; color: #6b7280; text-align: center;">
              © 2025 Meet and More. All rights reserved.
            </p>
          </div>
        </body>
        </html>
      `);
    } finally {
      session.endSession();
    }
  }
);

module.exports = paymentsRouter;
