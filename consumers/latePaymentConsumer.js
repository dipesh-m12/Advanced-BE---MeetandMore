const Redis = require("ioredis");
const { Worker, Queue } = require("bullmq");
const { v4: uuidv4 } = require("uuid");
const Profile = require("../models/authModel");
const Waitlist = require("../models/waitlistModel");
const Payment = require("../models/paymentModel");
const Team = require("../models/teamModel");
const { EventDate } = require("../models/DateModel");
const { VenueCity } = require("../models/eventModel");
const Notifications = require("../models/notisModel");
const { DateTime } = require("luxon");
const { sendMessageToKafka } = require("../utils/kafka");
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const sanitizeHtml = require("sanitize-html");
const UserDetails = require("../models/userDetailsModel");
const PaymentLogs = require("../models/paymentLogModel");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
  }
);

const QUEUE_NAME = "late-payment";
const CONCURRENCY = 1;

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

const runLatePaymentConsumer = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const { paymentId, userId, dateId, amount, currency, payment_id } =
              job.data;

            // Fetch user data with industry
            const userData = await Profile.aggregate([
              { $match: { _id: userId } },
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
                  name: 1,
                  email: 1,
                  pushtoken: 1,
                  gender: 1,
                  dob: 1,
                  industry: { $arrayElemAt: ["$details.WorkingIndustry", 0] },
                },
              },
            ]).session(session);

            const user = userData[0];
            if (!user) {
              throw new Error(`User not found: ${userId}`);
            }

            // Validate gender
            if (user.gender === "Other") {
              throw new Error(
                `User gender 'Other' not supported for team assignment: ${userId}`
              );
            }

            // Fetch event date and city
            const eventDate = await EventDate.findById(dateId).lean({
              session,
            });
            if (!eventDate) {
              throw new Error(`Event date not found: ${dateId}`);
            }
            const city = await VenueCity.findById(eventDate.city)
              .select("city_name timezone")
              .lean({ session });
            if (!city) {
              throw new Error(`City not found: ${eventDate.city}`);
            }

            const formattedDate = DateTime.fromJSDate(eventDate.date, {
              zone: "utc",
            })
              .setZone(city.timezone)
              .toLocaleString(DateTime.DATETIME_MED);

            // Create waitlist entry
            const newWaitlistEntry = new Waitlist({
              _id: uuidv4(),
              userId,
              dateId,
              paymentId,
              status: "waiting",
            });
            await newWaitlistEntry.save({ session });

            // Fetch existing teams
            const teams = await Team.find({ dateId, status: "formed" }).lean({
              session,
            });

            const userIndustry = user.industry || "Unknown";

            // Helper to check valid team ratios
            const isValidRatio = (males, females, size) => {
              if (size === 6) return males >= 2 && females >= 2;
              if (size === 5)
                return (
                  (males === 3 && females === 2) ||
                  (males === 2 && females === 3)
                );
              if (size === 4)
                return (
                  (males === 2 && females === 2) ||
                  (males === 1 && females === 3)
                );
              return false;
            };

            let assignedTeam = null;
            for (const team of teams) {
              if (team.members.length >= 6) continue;
              const maleCount = team.members.filter(
                (m) => m.gender === "Male"
              ).length;
              const femaleCount = team.members.filter(
                (m) => m.gender === "Female"
              ).length;
              const newMaleCount = maleCount + (user.gender === "Male" ? 1 : 0);
              const newFemaleCount =
                femaleCount + (user.gender === "Female" ? 1 : 0);
              const newSize = team.members.length + 1;

              if (isValidRatio(newMaleCount, newFemaleCount, newSize)) {
                assignedTeam = team;
                break;
              }
            }

            if (assignedTeam) {
              // Update team with new member
              await Team.updateOne(
                { _id: assignedTeam._id },
                {
                  $push: {
                    members: {
                      userId,
                      gender: user.gender,
                      dob: user.dob || null,
                    },
                  },
                },
                { session }
              );

              // Update waitlist to confirmed
              await Waitlist.updateOne(
                { userId, dateId, paymentId },
                { status: "confirmed" },
                { session }
              );

              // Fetch updated team with member details in one aggregation
              const teamData = await Team.aggregate([
                { $match: { _id: assignedTeam._id } },
                {
                  $unwind: {
                    path: "$members",
                    preserveNullAndEmptyArrays: true,
                  },
                },
                {
                  $lookup: {
                    from: Profile.collection.name,
                    localField: "members.userId",
                    foreignField: "_id",
                    as: "profile",
                  },
                },
                {
                  $unwind: {
                    path: "$profile",
                    preserveNullAndEmptyArrays: true,
                  },
                },
                {
                  $lookup: {
                    from: UserDetails.collection.name,
                    localField: "members.userId",
                    foreignField: "userId",
                    as: "details",
                  },
                },
                {
                  $group: {
                    _id: "$_id",
                    members: {
                      $push: {
                        userId: "$members.userId",
                        gender: "$members.gender",
                        dob: "$members.dob",
                        email: "$profile.email",
                        name: "$profile.name",
                        pushtoken: "$profile.pushtoken",
                        industry: {
                          $arrayElemAt: ["$details.WorkingIndustry", 0],
                        },
                      },
                    },
                  },
                },
              ]).session(session);

              const updatedTeam = teamData[0];
              if (!updatedTeam) {
                throw new Error(`Updated team not found: ${assignedTeam._id}`);
              }

              // Calculate team summary
              const teamSize = updatedTeam.members.length;
              const genderComposition = {
                Male: updatedTeam.members.filter((m) => m.gender === "Male")
                  .length,
                Female: updatedTeam.members.filter((m) => m.gender === "Female")
                  .length,
              };
              const ages = updatedTeam.members
                .map((m) => {
                  if (!m.dob) return null;
                  const dob = DateTime.fromJSDate(m.dob);
                  return dob.isValid
                    ? DateTime.now().diff(dob, "years").years
                    : null;
                })
                .filter((age) => age !== null && !isNaN(age));
              const averageAge = ages.length
                ? Math.round(
                    ages.reduce((sum, age) => sum + age, 0) / ages.length
                  )
                : "N/A";
              const industries =
                updatedTeam.members
                  .map((m) => m.industry || userIndustry)
                  .filter(Boolean)
                  .join(", ") || "Various";

              // Send notifications to existing team members
              const notifications = [];
              for (const member of updatedTeam.members) {
                if (member.userId === userId) continue;
                if (!member.email) {
                  console.warn(`Missing email for user: ${member.userId}`);
                  continue;
                }

                // Standard notifications
                notifications.push({
                  _id: uuidv4(),
                  userId: member.userId,
                  type: "message",
                  message: {
                    message: `A new member has joined your group for the event in ${city.city_name} on ${formattedDate}.`,
                    value: 0,
                  },
                  Requiresaction: false,
                });

                await sendMessageToKafka("bulk-email", {
                  to: member.email,
                  subject: "Meet and More - New Team Member Added",
                  templateName: "new-team-member",
                  data: sanitizeData({
                    name: member.name || "User",
                    city: city.city_name,
                    eventDate: formattedDate,
                    teamSize,
                  }),
                });

                if (member.pushtoken) {
                  await sendMessageToKafka("notification-batch", {
                    tokens: [member.pushtoken],
                    title: "New Team Member!",
                    body: `A new member has joined your group for the event in ${city.city_name} on ${formattedDate}.`,
                    data: { dateId },
                  });
                }

                await sendMessageToKafka("bulk-email", {
                  to: member.email,
                  subject: "Meet and More - Updated Group Summary",
                  templateName: "updated-group-summary",
                  data: sanitizeData({
                    name: member.name || "User",
                    eventDate: formattedDate,
                    city: city.city_name,
                    teamSize,
                    averageAge,
                    industries,
                    genderComposition: `Males: ${genderComposition.Male}, Females: ${genderComposition.Female}`,
                  }),
                });
              }

              // Notify the new user
              notifications.push({
                _id: uuidv4(),
                userId,
                type: "message",
                message: {
                  message: `You have been added to a group for the event in ${city.city_name} on ${formattedDate}.`,
                  value: 0,
                },
                Requiresaction: false,
              });

              await sendMessageToKafka("bulk-email", {
                to: user.email,
                subject: "Meet and More - Group Assignment Confirmation",
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
                  title: "Group Assigned!",
                  body: `You've been assigned to a group for the event in ${city.city_name} on ${formattedDate}.`,
                  data: { dateId },
                });
              }

              if (notifications.length) {
                await Notifications.insertMany(notifications, { session });
              }
            } else {
              // Refund the user
              const payment = await Payment.findOne({
                _id: paymentId,
                status: "paid",
              }).session(session);
              if (payment) {
                const refundAmount =
                  payment.currency === "INR"
                    ? Math.round(payment.amount * 100)
                    : payment.amount;
                const idempotencyKey = uuidv4();

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
                  const paymentDetails = await razorpay.payments.fetch(
                    payment.paymentId
                  );
                  logEntry.razorpayResponse = paymentDetails;

                  if (paymentDetails.status === "settled") {
                    logEntry.status = "failed";
                    logEntry.error =
                      "Payment already settled, requires manual refund";
                    await PaymentLogs.create([logEntry], { session });

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

                    const deadQueue = new Queue("dead-letter", {
                      connection: bullRedisClient,
                    });
                    await deadQueue.add("failed-refund", logEntry);
                    return;
                  }

                  const refund = await razorpay.payments.refund(
                    payment.paymentId,
                    {
                      amount: refundAmount,
                      notes: { idempotency_key: idempotencyKey },
                    }
                  );
                  logEntry.status = "success";
                  logEntry.razorpayResponse = refund;

                  payment.status = "refunded";
                  payment.refundId = refund.id;
                  await payment.save({ session });

                  await Waitlist.updateOne(
                    { userId, dateId, paymentId },
                    { status: "canceled" },
                    { session }
                  );
                  await PaymentLogs.create([logEntry], { session });

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

                  await Notifications.create(
                    [
                      {
                        _id: uuidv4(),
                        userId,
                        type: "message",
                        message: {
                          message: `Your booking for the event in ${city.city_name} on ${formattedDate} has been refunded as we couldn't assign you to a group.`,
                          value: 0,
                        },
                        Requiresaction: false,
                      },
                    ],
                    { session }
                  );
                } catch (err) {
                  logEntry.status = "failed";
                  logEntry.error = err.message;
                  await PaymentLogs.create([logEntry], { session });

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

                  const deadQueue = new Queue("dead-letter", {
                    connection: bullRedisClient,
                  });
                  await deadQueue.add("failed-refund", logEntry);
                }
              }
            }
          });
        } catch (err) {
          console.error(
            `❌ Error processing late payment job ${job.id}: ${
              err.message || err.toString()
            }`,
            err.stack,
            { jobData: job.data }
          );
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-late-payment", {
            original: job.data,
            error: err.message || err.toString(),
            stack: err.stack,
          });
          throw err;
        } finally {
          session.endSession();
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

    console.log(`✅ Late payment worker started for queue: ${QUEUE_NAME}`);

    worker.on("error", (err) =>
      console.error(`Worker error: ${err.message || err.toString()}`, err.stack)
    );
    worker.on("failed", (job, err) =>
      console.error(
        `❌ Job ${job.id} failed: ${err.message || err.toString()}`,
        err.stack,
        { jobData: job.data }
      )
    );

    return worker;
  } catch (err) {
    console.error(
      `Error starting worker: ${err.message || err.toString()}`,
      err.stack
    );
    throw err;
  }
};

runLatePaymentConsumer();
module.exports = { runLatePaymentConsumer };
