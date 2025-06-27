const mongoose = require("mongoose");
const { Kafka } = require("kafkajs");
const { DateTime } = require("luxon");
const { v4: uuidv4 } = require("uuid");
const sanitizeHtml = require("sanitize-html");
const Waitlist = require("../models/waitlistModel");
const Payment = require("../models/paymentModel");
const Profile = require("../models/authModel");
const { EventDate } = require("../models/DateModel");
const { VenueCity, Venue } = require("../models/eventModel");
const { sendMessageToKafka } = require("../utils/kafka");
const Team = require("../models/teamModel");
const Razorpay = require("razorpay");
const UserDetails = require("../models/userDetailsModel");
const Referral = require("../models/ReferralCodeModel");
const Reward = require("../models/RewardModel");
const path = require("path");
const Notifications = require("../models/notisModel");
require("dotenv").config({ path: path.resolve("../.env") });
const { getUserNames } = require("../utils/profileCache");
const QRCode = require("qrcode");
const PaymentLogs = require("../models/paymentLogModel");

const Redis = require("ioredis");
const { Worker, Queue } = require("bullmq");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
  }
);

const QUEUE_NAME = "group-assignment";
const CONCURRENCY = 1;

// Validate environment variables
const requiredEnv = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
const missingEnv = requiredEnv.filter((env) => !process.env[env]);
if (missingEnv.length) {
  throw new Error(`Missing environment variables: ${missingEnv.join(", ")}`);
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Sanitize data for notifications
const sanitizeData = (data) =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeHtml(value) : value,
    ])
  );

// Group assignment logic
const assignGroups = async (dateId, timezone) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      // Fetch waitlist entries
      const waitlistEntries = await Waitlist.find({ dateId, status: "waiting" })
        .select("userId paymentId")
        .lean({ session });
      if (!waitlistEntries.length) return { teams: [], unassigned: [] };

      // Fetch user data (Profile and UserDetails) in one query using aggregation
      const userIds = waitlistEntries.map((e) => e.userId);
      const userData = await Profile.aggregate([
        { $match: { _id: { $in: userIds } } },
        {
          $lookup: {
            from: UserDetails.collection.name,
            localField: "_id",
            foreignField: "userId",
            as: "details",
          },
        },
        {
          $project: {
            _id: 1,
            gender: 1,
            dob: 1,
            email: 1,
            name: 1,
            pushtoken: 1,
            industry: { $arrayElemAt: ["$details.WorkingIndustry", 0] },
          },
        },
      ]).session(session);

      const userMap = new Map(userData.map((u) => [u._id.toString(), u]));

      // Separate males and females
      let males = waitlistEntries.filter(
        (e) => userMap.get(e.userId.toString())?.gender === "Male"
      );
      let females = waitlistEntries.filter(
        (e) => userMap.get(e.userId.toString())?.gender === "Female"
      );

      const teams = [];
      const unassigned = [];

      // Helper to check valid team ratios
      const isValidRatio = (males, females, size) => {
        if (size === 5)
          return (
            (males === 3 && females === 2) ||
            (males === 2 && females === 3) ||
            (males === 5 && females === 0) ||
            (males === 0 && females === 5)
          );
        if (size === 4)
          return (
            (males === 2 && females === 2) ||
            (males === 1 && females === 3) ||
            (males === 4 && females === 0) ||
            (males === 0 && females === 4)
          );
        if (size === 3)
          return (
            (males === 3 && females === 0) ||
            (males === 0 && females === 3) ||
            (males === 1 && females === 2)
          );
        if (size === 6) return males >= 2 && females >= 2;
        return false;
      };

      // Form teams
      const formTeams = (males, females, preferredSize) => {
        const ratios = [
          { m: 3, f: 2 },
          { m: 2, f: 3 },
          { m: 2, f: 2 },
          { m: 1, f: 3 },
          { m: 1, f: 2 },
          { m: 0, f: 5 },
          { m: 0, f: 4 },
          { m: 0, f: 3 },
          { m: 5, f: 0 },
          { m: 4, f: 0 },
          { m: 3, f: 0 },
        ].filter(
          (r) =>
            r.m + r.f === preferredSize && isValidRatio(r.m, r.f, preferredSize)
        );

        for (const { m, f } of ratios) {
          if (m <= males.length && f <= females.length) {
            const teamMembers = [
              ...males.splice(0, m).map((e) => {
                const user = userMap.get(e.userId.toString());
                return {
                  userId: e.userId,
                  gender: "Male",
                  dob: user.dob || null,
                };
              }),
              ...females.splice(0, f).map((e) => {
                const user = userMap.get(e.userId.toString());
                return {
                  userId: e.userId,
                  gender: "Female",
                  dob: user.dob || null,
                };
              }),
            ];
            teams.push({ _id: uuidv4(), dateId, members: teamMembers });
            return true;
          }
        }
        return false;
      };

      // Form teams of size 5, 4, 3
      while (males.length + females.length >= 5) {
        if (!formTeams(males, females, 5)) break;
      }
      while (males.length + females.length >= 4) {
        if (!formTeams(males, females, 4)) break;
      }
      while (males.length + females.length >= 3) {
        if (!formTeams(males, females, 3)) break;
      }

      // Handle remaining females
      if (females.length > 0 && females.length <= 2) {
        for (let team of teams) {
          const femaleCount = team.members.filter(
            (m) => m.gender === "Female"
          ).length;
          if (team.members.length < 6 && femaleCount < 3) {
            const fCount = Math.min(females.length, 6 - team.members.length);
            team.members.push(
              ...females.splice(0, fCount).map((e) => {
                const user = userMap.get(e.userId.toString());
                return {
                  userId: e.userId,
                  gender: "Female",
                  dob: user.dob || null,
                };
              })
            );
            if (females.length === 0) break;
          }
        }
      }

      // Handle remaining males
      if (males.length >= 3) {
        for (let size = 5; size >= 3; size--) {
          if (males.length >= size && isValidRatio(size, 0, size)) {
            const teamMembers = males.splice(0, size).map((e) => {
              const user = userMap.get(e.userId.toString());
              return {
                userId: e.userId,
                gender: "Male",
                dob: user.dob || null,
              };
            });
            teams.push({ _id: uuidv4(), dateId, members: teamMembers });
          }
        }
      }

      // Add remaining users to unassigned
      unassigned.push(
        ...males.map((e) => e.userId),
        ...females.map((e) => e.userId)
      );

      // Fetch event and city details
      const eventDate = await EventDate.findById(dateId).lean({ session });
      if (!eventDate)
        throw new Error(`EventDate not found for dateId: ${dateId}`);
      const city = await VenueCity.findById(eventDate.city)
        .select("city_name timezone")
        .lean({ session });
      if (!city)
        throw new Error(`City not found for cityId: ${eventDate.city}`);
      const formattedDate = DateTime.fromJSDate(eventDate.date, { zone: "utc" })
        .setZone(city.timezone)
        .toLocaleString(DateTime.DATETIME_MED);

      // Save teams and update waitlist
      if (teams.length) {
        await Team.insertMany(teams, { session });
      }
      const assignedUserIds = teams.flatMap((t) =>
        t.members.map((m) => m.userId)
      );
      if (assignedUserIds.length) {
        await Waitlist.updateMany(
          { userId: { $in: assignedUserIds }, dateId },
          { status: "confirmed" },
          { session }
        );
      }

      // Create notifications for assigned users
      const teamNotifications = [];
      for (const team of teams) {
        const teamUserIds = team.members.map((m) => m.userId);
        const teamSize = team.members.length;
        const genderComposition = {
          Male: team.members.filter((m) => m.gender === "Male").length,
          Female: team.members.filter((m) => m.gender === "Female").length,
        };
        const ages = team.members
          .map((m) => {
            if (!m.dob) return null;
            const dob = DateTime.fromJSDate(m.dob);
            return dob.isValid ? DateTime.now().diff(dob, "years").years : null;
          })
          .filter((age) => age !== null && !isNaN(age));
        const averageAge = ages.length
          ? Math.round(ages.reduce((sum, age) => sum + age, 0) / ages.length)
          : "N/A";
        const industries =
          teamUserIds
            .map(
              (userId) => userMap.get(userId.toString())?.industry || "Unknown"
            )
            .filter(Boolean)
            .join(", ") || "Various";

        for (const member of team.members) {
          const user = userMap.get(member.userId.toString());
          if (user) {
            teamNotifications.push({
              _id: uuidv4(),
              userId: member.userId,
              type: "message",
              message: {
                message: `You have a date coming up tomorrow in ${city.city_name}! Get ready to meet your group of ${teamSize} at the event on ${formattedDate}.`,
                value: 0,
              },
              Requiresaction: false,
            });

            await sendMessageToKafka("bulk-email", {
              to: user.email,
              subject: "Meet and More - Event Group Confirmation",
              templateName: "group-confirmation",
              data: sanitizeData({
                name: user.name || "User",
                eventDate: formattedDate,
                city: city.city_name,
                teamSize,
                averageAge,
                industries,
                genderComposition: `Males: ${genderComposition.Male}, Females: ${genderComposition.Female}`,
              }),
            });

            if (user.pushtoken) {
              await sendMessageToKafka("notification-batch", {
                tokens: [user.pushtoken],
                title: "Team Assigned!",
                body: `You've been assigned to a group for the event in ${city.city_name} on ${formattedDate}. Check your email for details!`,
                data: { dateId },
              });
            }
          }
        }
      }

      if (teamNotifications.length) {
        await Notifications.insertMany(teamNotifications, { session });
      }

      // Refund unassigned users
      const refundNotifications = [];

      for (const userId of unassigned) {
        const waitlist = await Waitlist.findOne({ userId, dateId }).session(
          session
        );
        if (!waitlist) continue;
        const payment = await Payment.findOne({
          _id: waitlist.paymentId,
          status: "paid",
        }).session(session);
        if (!payment) continue;

        const refundAmount =
          payment.currency === "INR"
            ? Math.round(payment.amount * 100)
            : payment.amount;
        const idempotencyKey = uuidv4(); // Prevent duplicate refunds

        // Log refund attempt
        const logEntry = {
          _id: uuidv4(),
          paymentId: payment.paymentId,
          userId,
          dateId,
          action: "refund",
          amount: refundAmount,
          currency: payment.currency,
          status: "pending",
          createdAt: new Date(),
        };

        try {
          // Check payment status
          const paymentDetails = await razorpay.payments.fetch(
            payment.paymentId
          );
          logEntry.razorpayResponse = paymentDetails;

          if (paymentDetails.status === "settled") {
            logEntry.status = "failed";
            logEntry.error = "Payment already settled, requires manual refund";
            await PaymentLogs.create([logEntry], { session });

            const user = userMap.get(userId.toString());
            if (user) {
              await sendMessageToKafka("bulk-email", {
                to: process.env.EMAIL_USER || "mavinash422@gmail.com",
                subject: "Manual Refund Required - Settled Payment",
                templateName: "manual-refund-notification",
                data: sanitizeData({
                  userId,
                  userEmail: user.email,
                  paymentId: payment.paymentId,
                  amount: payment.amount,
                  currency: payment.currency,
                  eventDate: formattedDate,
                  city: city.city_name,
                  reason: logEntry.error,
                }),
              });
            }

            // Send to DLQ
            const deadQueue = new Queue("dead-letter", {
              connection: bullRedisClient,
            });
            await deadQueue.add("failed-refund", logEntry);
            continue;
          }

          // Process refund
          const refund = await razorpay.payments.refund(payment.paymentId, {
            amount: refundAmount,
            notes: { idempotency_key: idempotencyKey },
          });
          logEntry.status = "success";
          logEntry.razorpayResponse = refund;

          // Update DB
          payment.status = "refunded";
          payment.refundId = refund.id;
          await payment.save({ session });
          waitlist.status = "canceled";
          await waitlist.save({ session });
          await PaymentLogs.create([logEntry], { session });

          const user = userMap.get(userId.toString());
          if (user) {
            refundNotifications.push({
              _id: uuidv4(),
              userId,
              type: "message",
              message: {
                message: `Your booking for the event in ${city.city_name} on ${formattedDate} has been refunded as we couldn't assign you to a group.`,
                value: 0,
              },
              Requiresaction: false,
            });

            await sendMessageToKafka("bulk-email", {
              to: user.email,
              subject: "Meet and More - Refund Due to Unassigned Group",
              templateName: "refund-notification",
              data: sanitizeData({
                name: user.name || "User",
                amount: payment.amount,
                currency: payment.currency,
                refundId: refund.id,
                eventDate: formattedDate,
                city: city.city_name,
              }),
            });

            if (user.pushtoken) {
              await sendMessageToKafka("notification-batch", {
                tokens: [user.pushtoken],
                title: "Refund Processed",
                body: `Your booking for the event in ${city.city_name} on ${formattedDate} was refunded as we couldn't assign you to a group.`,
                data: { refundId: refund.id, dateId },
              });
            }
          }
        } catch (err) {
          logEntry.status = "failed";
          logEntry.error = err.message;
          await PaymentLogs.create([logEntry], { session });

          const user = userMap.get(userId.toString());
          if (user) {
            await sendMessageToKafka("bulk-email", {
              to: process.env.EMAIL_USER || "mavinash422@gmail.com",
              subject: "Refund Failure - Manual Action Required",
              templateName: "refund-failure-notification",
              data: sanitizeData({
                userId,
                userEmail: user.email,
                paymentId: payment.paymentId,
                amount: payment.amount,
                currency: payment.currency,
                eventDate: formattedDate,
                city: city.city_name,
                error: err.message,
              }),
            });
          }

          // Send to DLQ
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-refund", logEntry);
        }
      }

      if (refundNotifications.length) {
        await Notifications.insertMany(refundNotifications, { session });
      }

      result = { teams, unassigned };
    });
    return result || { teams: [], unassigned: [] };
  } catch (err) {
    console.error(
      `Group assignment error for dateId ${dateId}: ${err.message}`
    );
    return { teams: [], unassigned: [] };
  } finally {
    session.endSession();
  }
};

// Send venue notifications
const sendVenueNotifications = async (dateId) => {
  try {
    const teams = await Team.find({ dateId }).lean();
    if (!teams.length) {
      console.log(`No teams found for dateId: ${dateId}`);
      return;
    }

    const eventDate = await EventDate.findById(dateId).lean();
    if (!eventDate)
      throw new Error(`EventDate not found for dateId: ${dateId}`);
    const city = await VenueCity.findById(eventDate.city)
      .select("city_name timezone")
      .lean();
    const venue = await Venue.findOne({ city: eventDate.city, active: true })
      .select("name address")
      .lean();
    if (!city || !venue) {
      throw new Error(
        `City or active venue not found for cityId: ${eventDate.city}`
      );
    }

    const formattedDate = DateTime.fromJSDate(eventDate.date, { zone: "utc" })
      .setZone(city.timezone)
      .toLocaleString(DateTime.DATETIME_MED);

    const userIds = teams.flatMap((team) =>
      team.members.map((member) => member.userId)
    );
    const users = await Profile.find(
      { _id: { $in: userIds } },
      "email name pushtoken"
    ).lean();
    const userMap = new Map(users.map((user) => [user._id.toString(), user]));

    const waitlistEntries = await Waitlist.find(
      { dateId, userId: { $in: userIds } },
      "_id userId"
    ).lean();
    const waitlistMap = new Map(
      waitlistEntries.map((entry) => [
        entry.userId.toString(),
        entry._id.toString(),
      ])
    );

    const venueNotifications = [];
    for (const team of teams) {
      for (const member of team.members) {
        const user = userMap.get(member.userId);
        if (user) {
          const waitlistId = waitlistMap.get(member.userId);
          if (!waitlistId) {
            console.warn(
              `No waitlist entry found for user ${member.userId} and dateId ${dateId}`
            );
            continue;
          }

          // Generate QR code URL
          const siteUrl = `https://meetandmore-media.s3.eu-north-1.amazonaws.com/barcode.html?waitlistId=${waitlistId}`;
          let qrCodeUrl;
          try {
            qrCodeUrl = await QRCode.toDataURL(siteUrl);
          } catch (err) {
            console.error(
              `Failed to generate QR code for waitlistId ${waitlistId}: ${err.message}`
            );
            continue;
          }
          // Create notification
          venueNotifications.push({
            _id: uuidv4(),
            userId: member.userId,
            type: "message",
            message: {
              message: `Your assigned venue is ${venue.name} at ${venue.address} for the event in ${city.city_name} on ${formattedDate}.`,
              value: 0,
            },
            Requiresaction: false,
          });

          // Send email with QR code
          await sendMessageToKafka("bulk-email", {
            to: user.email,
            subject: "Meet and More - Your Event Venue Revealed!",
            templateName: "group-confirmation-venue",
            data: sanitizeData({
              name: user.name || "User",
              eventDate: formattedDate,
              city: city.city_name,
              venue: venue.name,
              address: venue.address,
              attendanceQr: qrCodeUrl,
              waitlistId,
            }),
          });

          // Send push notification
          if (user.pushtoken) {
            await sendMessageToKafka("notification-batch", {
              tokens: [user.pushtoken],
              title: "Venue Revealed!",
              body: `The venue for your event in ${city.city_name} on ${formattedDate} has been revealed. Check your email for details!`,
              data: { dateId },
            });
          }
        }
      }
    }

    // Insert venue notifications
    if (venueNotifications.length) {
      await Notifications.insertMany(venueNotifications);
    }

    console.log(`Venue notifications sent for dateId: ${dateId}`);
  } catch (err) {
    console.error(
      `Venue notification error for dateId ${dateId}: ${err.message}`
    );
  }
};

// Kafka consumer for group assignment
const runGroupAssignmentConsumer = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          const { dateId, timezone } = job.data;
          await assignGroups(dateId, timezone);
          console.log(`Group assignment completed for dateId: ${dateId}`);
        } catch (err) {
          console.error(`❌ Error processing job ${job.id}: ${err.message}`);
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-group-assignment", {
            original: job.data,
            error: err.message,
          });
          throw err;
        }
      },
      {
        connection: bullRedisClient,
        concurrency: CONCURRENCY,
        removeOnComplete: true,
        removeOnFail: { age: 86400 },
        limiter: { max: 50, duration: 5000 },
      }
    );

    console.log(
      `✅ Group assignment worker started for queue: ${QUEUE_NAME} (Concurrency: ${CONCURRENCY})`
    );

    worker.on("error", (err) => console.error("❌ Worker error:", err));
    worker.on("failed", (job, err) =>
      console.error(`❌ Job ${job.id} failed: ${err.message}`)
    );

    return worker;
  } catch (err) {
    console.error("❌ Worker failed:", err);
    throw err;
  }
};

runGroupAssignmentConsumer();

// Invoke group assignment
const invokeGroupAssignment = async (dateId) => {
  try {
    const eventDate = await EventDate.findById(dateId).lean();
    if (!eventDate) {
      console.error(`Event date not found: ${dateId}`);
      return;
    }
    const city = await VenueCity.findById(eventDate.city)
      .select("timezone")
      .lean();
    if (!city) {
      console.error(`City not found: ${eventDate.city}`);
      return;
    }

    await sendMessageToKafka("group-assignment", {
      dateId,
      timezone: city.timezone,
    });
  } catch (err) {
    console.error(
      `Invoke group assignment error for dateId ${dateId}: ${err.message}`
    );
  }
};

const sendFollowUpEmails = async (dateId) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const teams = await Team.find({ dateId }).lean({ session });
      const eventDate = await EventDate.findById(dateId).lean({ session });
      if (!eventDate)
        throw new Error(`EventDate not found for dateId: ${dateId}`);
      const city = await VenueCity.findById(eventDate.city)
        .select("city_name timezone")
        .lean({ session });
      if (!city)
        throw new Error(`City not found for cityId: ${eventDate.city}`);
      const formattedDate = DateTime.fromJSDate(eventDate.date, { zone: "utc" })
        .setZone(city.timezone)
        .toLocaleString(DateTime.DATETIME_MED);

      const userIds = teams.flatMap((team) =>
        team.members.map((member) => member.userId)
      );
      if (!userIds.length) {
        console.log(
          `No users found for dateId: ${dateId}, skipping follow-up emails`
        );
        return;
      }

      const users = await Profile.find(
        { _id: { $in: userIds } },
        "email name"
      ).lean({ session });
      const userMap = new Map(users.map((user) => [user._id.toString(), user]));
      // Fetch usernames for notifications
      const userNames = await getUserNames(userIds);
      // Create notifications
      const notifications = [];
      for (const team of teams) {
        for (const member of team.members) {
          const user = userMap.get(member.userId);
          if (!user) continue;

          // Create anotherDinner notifications for other team members
          for (const otherMember of team.members) {
            if (otherMember.userId === member.userId) continue; // Skip self
            const otherUserName =
              userNames.get(otherMember.userId) || "a fellow participant";
            notifications.push({
              _id: uuidv4(),
              userId: member.userId,
              type: "anotherDinner",
              message: {
                message: `Would you like to have another dinner with ${otherUserName}?`,
                value: 0,
              }, // Placeholder to satisfy schema
              Anotherdinner: {
                message: `Would you like to have another dinner with ${otherUserName}?`,
                value: false,
              },
              Requiresaction: true,
            });
          }

          // Create rateExp notification
          notifications.push({
            _id: uuidv4(),
            userId: member.userId,
            type: "rateExp",
            message: {
              message: `Please rate your experience at the event in ${city.city_name} on ${formattedDate}.`,
              value: 0,
            }, // Placeholder to satisfy schema
            RateExp: {
              message: `Please rate your experience at the event in ${city.city_name} on ${formattedDate}.`,
              value: 0,
            },
            Requiresaction: true,
          });

          // Send follow-up email
          await sendMessageToKafka("bulk-email", {
            to: user.email,
            subject: "Meet and More - How Was Your Event?",
            templateName: "event-follow-up",
            data: sanitizeData({
              name: user.name || "User",
              eventDate: formattedDate,
              city: city.city_name,
            }),
          });
        }
      }

      // Insert notifications
      if (notifications.length) {
        await Notifications.insertMany(notifications, { session });
      }
      // Update waitlist status to completed
      await Waitlist.updateMany(
        { dateId, userId: { $in: userIds }, status: "confirmed" },
        { status: "completed" },
        { session }
      );
    });

    // Call assignCouponRewards after transaction commits
    await assignCouponRewards(dateId, null);

    console.log(
      `Follow-up emails enqueued, notifications sent, waitlist updated, and coupon rewards processed for dateId: ${dateId}`
    );
  } catch (err) {
    console.error(`Follow-up email error for dateId ${dateId}: ${err.message}`);
  } finally {
    session.endSession();
  }
};

const assignCouponRewards = async (dateId, session = null) => {
  try {
    const queryOptions = session ? { session } : {};

    const waitlists = await Waitlist.find(
      {
        dateId,
        status: "completed",
      },
      null,
      queryOptions
    )
      .select("userId paymentId")
      .lean();

    if (!waitlists.length) {
      console.log(`No completed waitlists found for dateId: ${dateId}`);
      return;
    }

    for (const waitlist of waitlists) {
      const payment = await Payment.findOne(
        {
          _id: waitlist.paymentId,
          status: "paid",
        },
        null,
        queryOptions
      )
        .select("couponCode userId")
        .lean();

      if (!payment || !payment.couponCode) {
        continue; // Skip if no payment or no coupon used
      }

      // Find and update referral
      const referral = await Referral.findOne(
        {
          code: payment.couponCode,
          status: "active",
        },
        null,
        queryOptions
      );

      if (!referral) {
        console.log(`Invalid or inactive coupon: ${payment.couponCode}`);
        continue;
      }

      if (referral.type === "special" && referral.usageCount >= 1) {
        console.log(`Special code ${payment.couponCode} already used`);
        continue;
      }

      referral.usageCount += 1;
      await referral.save(queryOptions);

      // Check if owner reward threshold is met for standard referrals
      if (
        referral.type === "standard" &&
        referral.usageCount % referral.rewardAfterUsages === 0 &&
        referral.userId
      ) {
        // Fetch owner profile
        const owner = await Profile.findOne(
          { _id: referral.userId },
          null,
          queryOptions
        )
          .select(
            "phone_number name email country_code gender city location region_currency"
          )
          .lean();

        if (!owner) {
          console.log(`Owner not found for referral: ${referral._id}`);
          continue;
        }

        // Fetch reward configuration
        const reward = await Reward.findOne(
          {
            referralType: referral.type,
          },
          null,
          queryOptions
        ).lean();

        if (!reward) {
          console.log(
            `Reward configuration not found for type: ${referral.type}`
          );
          continue;
        }

        // Calculate owner reward
        const ownerCurrency = owner.region_currency || "INR";
        const ownerReward = reward[ownerCurrency]?.ownerReward || 0;

        // Send notification to owner
        await sendMessageToKafka("bulk-email", {
          to: process.env.EMAIL_USER,
          subject: "🎉 Referral Reward Earned - Meet and More",
          templateName: "owner-reward",
          data: sanitizeData({
            name: owner.name || "User",
            email: owner.email || "N/A",
            phoneNumber: owner.phone_number || "N/A",
            countryCode: owner.country_code || "N/A",
            gender: owner.gender || "N/A",
            city: owner.city || "N/A",
            location: owner.location || "N/A",
            reward: ownerReward,
            usageCount: referral.usageCount,
            code: referral.code,
            currency: ownerCurrency,
          }),
        });
      }
    }

    console.log(`Coupon rewards processed for dateId: ${dateId}`);
  } catch (err) {
    console.error(
      `Error assigning coupon rewards for dateId ${dateId}: ${err.message}`
    );
    throw err; // Rethrow to handle in transaction
  }
};

module.exports = {
  invokeGroupAssignment,
  sendFollowUpEmails,
  sendVenueNotifications,
};
