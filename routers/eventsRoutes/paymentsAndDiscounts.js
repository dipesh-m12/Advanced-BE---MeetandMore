const express = require("express");
const { body, query, validationResult } = require("express-validator");
const { VenueCity, Venue } = require("../../models/eventModel");
const { EventDate } = require("../../models/DateModel");
const Profile = require("../../models/authModel");
const Referral = require("../../models/ReferralCodeModel");
const Reward = require("../../models/RewardModel");
const Payment = require("../../models/paymentModel");
const Waitlist = require("../../models/waitlistModel");
const verifyJWT = require("../../middlewares/verifyJWT");
const currencies = require("../../utils/data");
const { v4: uuidv4 } = require("uuid");
const paymentsRouter = express.Router();
const { DateTime } = require("luxon");
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const sanitizeHtml = require("sanitize-html");
const { sendMessageToKafka } = require("../../utils/kafka");
const PaymentLogs = require("../../models/paymentLogModel");
const { sendToDeadLetter } = require("../../utils/deadLetter");

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("Razorpay credentials missing in environment variables");
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const sanitizeData = (data) =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeHtml(value) : value,
    ])
  );

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      data: null,
    });
  }
  next();
};

// GET /api/payments/check-first-time-discount - Check if user can avail first-time discount and get discount amount
paymentsRouter.get(
  "/check-first-time-discount",
  verifyJWT,
  [query("cityId").notEmpty().withMessage("City ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const userId = req.user.uuid;
      const { cityId } = req.query;

      // Fetch user
      const user = await Profile.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
          data: null,
        });
      }

      // Fetch city
      const city = await VenueCity.findById(cityId);
      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      let discountAmount = 0;
      const isEligible = !user.hasAvailedFirstTimeDiscount;

      // Calculate discount amount if eligible
      if (isEligible) {
        const firstTimeReward = await Reward.findOne({
          referralType: "first-time",
        });
        if (firstTimeReward) {
          discountAmount =
            firstTimeReward[city.region_currency]?.userReward || 0;
        }
      }

      return res.status(200).json({
        success: true,
        message: "First-time discount eligibility checked",
        data: {
          eligible: isEligible,
          discountAmount,
          currency: city.region_currency,
        },
      });
    } catch (err) {
      console.error("Error checking first-time discount:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to check first-time discount",
        data: null,
      });
    }
  }
);

// POST /api/payments/create-order - Create order based on date ID
paymentsRouter.post(
  "/create-order",
  verifyJWT,
  [
    body("dateId").notEmpty().withMessage("Date ID is required"),
    body("couponCode")
      .optional()
      .isString()
      .withMessage("Coupon code must be a string"),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { dateId, couponCode } = req.body;
      const userId = req.user.uuid;

      // Check for existing paid payment for userId and dateId
      const existingPayment = await Payment.findOne({
        userId,
        dateId,
        status: "paid",
      });
      if (existingPayment) {
        throw new Error("User has already paid for this event");
      }

      // Fetch event date
      const eventDate = await EventDate.findById(dateId).lean();
      if (!eventDate || !eventDate.isAvailable) {
        return res.status(404).json({
          success: false,
          message: "Event date not found or unavailable",
          data: null,
        });
      }

      // Fetch city
      const city = await VenueCity.findById(eventDate.city).select(
        "timezone amount region_currency"
      );
      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      // Check for active venue in city

      const activeVenue = await Venue.findOne({
        city: eventDate.city,
        active: true,
        preventFutureBooking: false,
      });
      if (!activeVenue) {
        return res.status(400).json({
          success: false,
          message: "No active venue available in this city",
          data: null,
        });
      }

      // Check noon deadline in city's local timezone
      const timezone = city.timezone;
      const now = DateTime.now().setZone(timezone);
      const eventLocal = DateTime.fromJSDate(eventDate.date, {
        zone: "utc",
      }).setZone(timezone);
      const noonDeadline = eventLocal.set({ hour: 12, minute: 0, second: 0 });
      if (now > noonDeadline) {
        return res.status(400).json({
          success: false,
          message: "Booking deadline (noon local time) has passed",
          data: null,
        });
      }

      // Fetch user
      const user = await Profile.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
          data: null,
        });
      }

      let originalAmount = city.amount;
      let currency = city.region_currency;
      let finalAmount = originalAmount;
      let firstTimeDiscount = 0;
      let couponDiscount = 0;

      // Apply first-time discount
      if (!user.hasAvailedFirstTimeDiscount) {
        const firstTimeReward = await Reward.findOne({
          referralType: "first-time",
        });
        if (firstTimeReward) {
          firstTimeDiscount = firstTimeReward[currency]?.userReward || 0;
          finalAmount = Math.max(1, finalAmount - firstTimeDiscount);
          user.hasAvailedFirstTimeDiscount = true;
          await user.save();
        }
      }

      // Apply coupon code
      if (couponCode) {
        const referral = await Referral.findOne({
          code: couponCode,
          status: "active",
        });
        if (!referral) {
          return res.status(400).json({
            success: false,
            message: "Invalid or inactive coupon code",
            data: null,
          });
        }
        if (referral.userId && referral.userId === userId) {
          return res.status(400).json({
            success: false,
            message: "Cannot use your own coupon code",
            data: null,
          });
        }
        if (referral.type === "special" && referral.usageCount >= 1) {
          return res.status(400).json({
            success: false,
            message: "Special code has already been used",
            data: null,
          });
        }

        const reward = await Reward.findOne({ referralType: referral.type });
        if (!reward) {
          return res.status(500).json({
            success: false,
            message: "Reward configuration not found",
            data: null,
          });
        }

        couponDiscount = reward[currency]?.userReward || 0;
        finalAmount = Math.max(1, finalAmount - couponDiscount);
      }

      // Create Razorpay order
      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100),
        currency,
        receipt: `receipt_${Date.now()}`,
      });

      // Save payment
      const payment = new Payment({
        _id: uuidv4(),
        userId,
        orderId: order.id,
        amount: finalAmount,
        currency,
        status: "created",
        platform: "razorpay",
        couponCode: couponCode || null,
        discountApplied: firstTimeDiscount + couponDiscount,
        dateId, // Store date ID
      });
      await payment.save();

      return res.status(200).json({
        success: true,
        message: "Order created",
        data: {
          orderId: order.id,
          originalAmount,
          currency,
          finalAmount,
          breakdown: {
            originalAmount,
            firstTimeDiscount,
            couponDiscount,
            finalAmount,
          },
          key: process.env.RAZORPAY_KEY_ID,
        },
      });
    } catch (err) {
      console.error("Error creating order:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to create order: " + (err.message || "Unknown error"),
        data: null,
      });
    }
  }
);

// POST /api/payments/refund - Process refund with cancellation policy
paymentsRouter.post(
  "/refund",
  verifyJWT,
  [body("dateId").notEmpty().withMessage("Date ID is required")],
  handleValidationErrors,
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const { dateId } = req.body;
        const userId = req.user.uuid;
        const idempotencyKey = uuidv4();
        let payment = null,
          waitlist = null,
          eventDate = null,
          city = null,
          user = null;

        // Fetch waitlist entry
        waitlist = await Waitlist.findOne({
          userId,
          dateId,
          status: { $in: ["waiting", "confirmed"] },
        }).session(session);
        if (!waitlist || !waitlist.dateId) {
          throw new Error(
            "Waitlist entry not found or not eligible for cancellation"
          );
        }

        // Fetch payment
        payment = await Payment.findOne({
          _id: waitlist.paymentId,
          userId,
          status: "paid",
        }).session(session);
        if (!payment) {
          throw new Error("Payment not found or not eligible for refund");
        }

        // Fetch event date and city
        eventDate = await EventDate.findById(dateId).lean().session(session);
        if (!eventDate) {
          throw new Error("Event date not found");
        }
        city = await VenueCity.findById(eventDate.city)
          .select("city_name timezone")
          .lean()
          .session(session);
        if (!city) {
          throw new Error("City not found");
        }

        // Check 24-hour cancellation window
        const bookingTime = DateTime.fromJSDate(payment.createdAt, {
          zone: "utc",
        });
        const cancelDeadline = bookingTime.plus({ hours: 24 });
        const now = DateTime.now().setZone(city.timezone);
        if (now > cancelDeadline) {
          throw new Error(
            "Cancellation not allowed after 24 hours from booking"
          );
        }

        // Check if booking was made before Friday 00:01 AM of event week
        const eventLocal = DateTime.fromJSDate(eventDate.date, {
          zone: "utc",
        }).setZone(city.timezone);
        const eventWeekStart = eventLocal.startOf("week");
        const fridayMidnight = eventWeekStart.plus({
          days: 4,
          hours: 0,
          minutes: 1,
        });
        if (bookingTime.setZone(city.timezone) >= fridayMidnight) {
          throw new Error(
            "Cancellation not allowed for bookings made on or after Friday 00:01 AM of event week"
          );
        }

        // Fetch user for email and push token
        user = await Profile.findById(userId)
          .select("email name pushtoken")
          .lean()
          .session(session);
        if (!user) {
          throw new Error("User not found");
        }

        // Check payment settlement
        const paymentDetails = await razorpay.payments.fetch(payment.paymentId);
        const refundAmount = Math.round(payment.amount * 100);
        const formattedDate = DateTime.fromJSDate(eventDate.date, {
          zone: "utc",
        })
          .setZone(city.timezone)
          .toLocaleString(DateTime.DATETIME_MED);

        // Log refund attempt
        const createLogEntry = (
          status,
          error = null,
          razorpayResponse = null
        ) => ({
          _id: uuidv4(),
          paymentId: payment.paymentId,
          userId,
          dateId: waitlist.dateId,
          action: "refund",
          amount: payment.amount,
          currency: payment.currency,
          status,
          razorpayResponse: razorpayResponse || {
            idempotency_key: idempotencyKey,
          },
          error,
          createdAt: new Date(),
        });
        await PaymentLogs.create([createLogEntry("pending")], { session });

        if (paymentDetails.status === "settled") {
          const logEntry = createLogEntry(
            "failed",
            "Payment already settled, requires manual refund",
            paymentDetails
          );
          await PaymentLogs.create([logEntry], { session });

          await sendToDeadLetter("failed-refund", {
            original: {
              userId,
              dateId: waitlist.dateId,
              paymentId: payment.paymentId,
              amount: payment.amount,
              currency: payment.currency,
            },
            error: "Payment already settled",
          });

          await sendMessageToKafka("bulk-email", {
            to: process.env.EMAIL_USER,
            subject: "Manual Refund Required - Settled Payment",
            templateName: "manual-refund-notification",
            data: sanitizeHtml({
              userId,
              userEmail: user.email || "N/A",
              paymentId: payment.paymentId,
              amount: payment.amount,
              currency: payment.currency,
              eventDate: formattedDate,
              city: city.city_name,
              reason: "Payment already settled",
            }),
          });

          await sendMessageToKafka("bulk-email", {
            to: user.email,
            subject: "Refund Request Update",
            templateName: "refund-failure-notification",
            data: sanitizeHtml({
              userId,
              userEmail: user.email || "N/A",
              paymentId: payment.paymentId,
              amount: payment.amount,
              currency: payment.currency,
              eventDate: formattedDate,
              city: city.city_name,
              error:
                "Payment is settled, our team is reviewing your refund request",
            }),
          });

          throw new Error("Payment is settled, manual refund required");
        }

        // Process refund
        const refund = await razorpay.payments.refund(payment.paymentId, {
          amount: refundAmount,
          notes: { idempotency_key: idempotencyKey },
        });
        if (!refund || !refund.id) {
          const logEntry = createLogEntry(
            "failed",
            "Razorpay refund failed: No refund ID returned",
            refund
          );
          await PaymentLogs.create([logEntry], { session });
          throw new Error("Failed to process Razorpay refund");
        }

        // Update log
        await PaymentLogs.create([createLogEntry("success", null, refund)], {
          session,
        });

        // Update payment status
        payment.status = "refunded";
        payment.refundId = refund.id;
        await payment.save({ session });

        // Update waitlist status
        waitlist.status = "canceled";
        await waitlist.save({ session });

        // Validate email data
        if (
          !user.email ||
          !payment.amount ||
          !payment.currency ||
          !refund.id ||
          !formattedDate ||
          !city.city_name
        ) {
          const logEntry = createLogEntry(
            "failed",
            "Invalid email data for refund confirmation",
            { user, payment, refund, formattedDate, city }
          );
          await PaymentLogs.create([logEntry], { session });
          throw new Error("Invalid data for refund confirmation email");
        }

        // Debug email data
        const emailData = {
          name: user.name || "User",
          amount: payment.amount,
          currency: payment.currency,
          refundId: refund.id,
          eventDate: formattedDate,
          city: city.city_name,
        };
        const sanitizedData = sanitizeHtml(emailData);

        // Send refund email
        await sendMessageToKafka("bulk-email", {
          to: user.email,
          subject: "Meet and More - Refund Confirmation",
          templateName: "refund-notification",
          data: {
            name: user.name || "User",
            amount: payment.amount,
            currency: payment.currency,
            refundId: refund.id,
            eventDate: formattedDate,
            city: city.city_name,
          },
        });

        // Send push notification
        if (user.pushtoken) {
          await sendMessageToKafka("notification-batch", {
            tokens: [user.pushtoken],
            title: "Refund Processed",
            body: `Your refund of ${payment.currency} ${payment.amount} for the event in ${city.city_name} on ${formattedDate} has been processed.`,
            data: { refundId: refund.id, dateId: waitlist.dateId },
          });
        }

        return res.status(200).json({
          success: true,
          message: "Refund processed and waitlist canceled",
          data: { refundId: refund.id },
        });
      });
    } catch (err) {
      console.error("Refund error:", err.message || err);
      return res
        .status(
          err.message?.includes("not found") ||
            err.message?.includes("not allowed") ||
            err.message?.includes("settled") ||
            err.message?.includes("Razorpay refund") ||
            err.message?.includes("Invalid data")
            ? 400
            : 500
        )
        .json({
          success: false,
          message:
            "Failed to process refund: " + (err.message || "Unknown error"),
          data: null,
        });
    } finally {
      session.endSession();
    }
  }
);

// POST /api/payments/no-show-refund
paymentsRouter.post(
  "/no-show-refund",
  verifyJWT,
  [body("dateId").notEmpty().withMessage("Date ID is required")],
  handleValidationErrors,
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const { dateId } = req.body;
        const userId = req.user.uuid;
        const idempotencyKey = uuidv4();
        let waitlist = null,
          payment = null,
          eventDate = null,
          venueCity = null,
          reward = null,
          refundAmount = 0,
          formattedDate = null;

        // Validate Waitlist entry
        waitlist = await Waitlist.findOne({
          dateId,
          userId,
          status: "completed",
        }).lean({ session });
        if (!waitlist || !waitlist.dateId) {
          throw new Error(
            "No completed waitlist entry found or missing dateId"
          );
        }

        // Check attendance
        if (!waitlist.attendance) {
          throw new Error(
            "Cannot request a no-show refund: attendance was not marked for this event"
          );
        }

        // Check for latitude and longitude
        if (waitlist.latitude === null || waitlist.longitude === null) {
          throw new Error(
            "We detected suspicious behavior (location data missing). Please contact the admin for assistance."
          );
        }

        // Validate Payment and populate userId
        payment = await Payment.findOne({
          _id: waitlist.paymentId,
          status: "paid",
        })
          .populate({
            path: "userId",
            select: "name email pushtoken",
          })
          .lean({ session });
        if (!payment || !payment.userId) {
          throw new Error("No paid payment or user details found");
        }

        // Get EventDate and VenueCity
        eventDate = await EventDate.findById(dateId).lean({ session });
        if (!eventDate) {
          throw new Error("Event date not found");
        }
        venueCity = await VenueCity.findById(eventDate.city)
          .select("city_name region_currency timezone")
          .lean({ session });
        if (!venueCity) {
          throw new Error("City not found");
        }

        // Get no-show reward amount
        reward = await Reward.findOne({
          referralType: "no-show",
        }).lean({ session });
        if (!reward) {
          throw new Error("No-show reward configuration not found");
        }
        refundAmount = reward[venueCity.region_currency]?.userReward || 0;
        if (refundAmount === 0) {
          throw new Error(
            `No-show reward not configured for ${venueCity.region_currency}`
          );
        }

        // Format date
        formattedDate = DateTime.fromJSDate(eventDate.date, {
          zone: "utc",
        })
          .setZone(venueCity.timezone)
          .toLocaleString(DateTime.DATETIME_MED);

        // Check payment settlement
        const paymentDetails = await razorpay.payments.fetch(payment.paymentId);
        if (paymentDetails.status === "settled") {
          const logEntry = {
            _id: uuidv4(),
            paymentId: payment.paymentId,
            userId,
            dateId: waitlist.dateId,
            action: "refund",
            amount: refundAmount,
            currency: venueCity.region_currency,
            status: "failed",
            error: "Payment already settled, requires manual refund",
            razorpayResponse: paymentDetails,
            createdAt: new Date(),
          };
          await PaymentLogs.create([logEntry], { session });

          await sendToDeadLetter("failed-no-show-refund", {
            original: {
              userId,
              dateId: waitlist.dateId,
              paymentId: payment.paymentId,
              refundAmount,
              currency: venueCity.region_currency,
              latitude: waitlist.latitude,
              longitude: waitlist.longitude,
            },
            error: "Payment already settled",
          });

          if (!payment.userId.email || !venueCity.city_name || !formattedDate) {
            const logEntry = {
              _id: uuidv4(),
              paymentId: payment.paymentId,
              userId,
              dateId: waitlist.dateId,
              action: "refund",
              amount: refundAmount,
              currency: venueCity.region_currency,
              status: "failed",
              error: "Invalid email data for settled payment notification",
              razorpayResponse: { payment, venueCity, formattedDate },
              createdAt: new Date(),
            };
            await PaymentLogs.create([logEntry], { session });
            throw new Error("Invalid data for settled payment notification");
          }

          const adminEmailData = {
            userId,
            userEmail: payment.userId.email || "N/A",
            paymentId: payment.paymentId,
            amount: refundAmount,
            currency: venueCity.region_currency,
            eventDate: formattedDate,
            city: venueCity.city_name,
            reason: "Payment already settled",
          };

          await sendMessageToKafka("bulk-email", {
            to: process.env.EMAIL_USER,
            subject: "Manual Refund Required - Settled No-Show Payment",
            templateName: "manual-refund-notification",
            data: adminEmailData,
          });

          const userEmailData = {
            userId,
            userEmail: payment.userId.email,
            paymentId: payment.paymentId,
            amount: refundAmount,
            currency: venueCity.region_currency,
            eventDate: formattedDate,
            city: venueCity.city_name,
            error:
              "Payment is settled, our team is reviewing your no-show refund request",
          };

          await sendMessageToKafka("bulk-email", {
            to: payment.userId.email,
            subject: "No-Show Refund Request Update",
            templateName: "refund-failure-notification",
            data: userEmailData,
          });

          throw new Error("Payment is settled, manual refund required");
        }

        // Log refund request
        const logEntry = {
          _id: uuidv4(),
          paymentId: payment.paymentId,
          userId,
          dateId: waitlist.dateId,
          action: "refund",
          amount: refundAmount,
          currency: venueCity.region_currency,
          status: "pending",
          razorpayResponse: { idempotency_key: idempotencyKey },
          createdAt: new Date(),
        };
        await PaymentLogs.create([logEntry], { session });

        // Validate admin email data
        if (!payment.userId.email || !venueCity.city_name || !formattedDate) {
          const logEntry = {
            _id: uuidv4(),
            paymentId: payment.paymentId,
            userId,
            dateId: waitlist.dateId,
            action: "refund",
            amount: refundAmount,
            currency: venueCity.region_currency,
            status: "failed",
            error: "Invalid email data for no-show refund approval",
            razorpayResponse: { payment, venueCity, formattedDate },
            createdAt: new Date(),
          };
          await PaymentLogs.create([logEntry], { session });
          throw new Error("Invalid data for no-show refund approval email");
        }

        // Send admin email for refund approval
        const adminApprovalEmailData = {
          userName: payment.userId.name || "User",
          userEmail: payment.userId.email || "N/A",
          userId,
          refundAmount,
          currency: venueCity.region_currency,
          eventDate: formattedDate,
          city: venueCity.city_name,
          paymentId: payment.paymentId,
          latitude: waitlist.latitude,
          longitude: waitlist.longitude,
        };

        await sendMessageToKafka("bulk-email", {
          to: process.env.EMAIL_USER,
          subject: "No-Show Refund Approval Request",
          templateName: "no-show-refunded",
          data: adminApprovalEmailData,
        });

        // Send push notification if pushtoken exists
        if (payment.userId.pushtoken) {
          const notificationData = {
            tokens: [payment.userId.pushtoken],
            title: "No-Show Refund Request Submitted",
            body: `Your refund request of ${venueCity.region_currency} ${refundAmount} for the event in ${venueCity.city_name} on ${formattedDate} has been submitted for approval.`,
            data: { dateId: waitlist.dateId },
          };

          await sendMessageToKafka("notification-batch", {
            ...notificationData,
          });
        }

        return res.status(200).json({
          success: true,
          message: "No-show refund request submitted successfully",
          data: null,
        });
      });
    } catch (err) {
      console.error(
        `Error submitting no-show refund request for user ${
          req.user.uuid || "unknown"
        }, dateId ${req.body.dateId}:`,
        err.message || err
      );
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to submit no-show refund request",
        data: null,
      });
    } finally {
      session.endSession();
    }
  }
);

module.exports = paymentsRouter;
