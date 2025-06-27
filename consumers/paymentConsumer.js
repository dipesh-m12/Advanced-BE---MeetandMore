const Redis = require("ioredis");
const { Worker, Queue } = require("bullmq");
const { v4: uuidv4 } = require("uuid");
const Profile = require("../models/authModel");
const Waitlist = require("../models/waitlistModel");
const { EventDate } = require("../models/DateModel");
const { VenueCity } = require("../models/eventModel");
const Notifications = require("../models/notisModel");
const { DateTime } = require("luxon");
const { sendMessageToKafka } = require("../utils/kafka");
const PaymentLogs = require("../models/paymentLogModel");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
  }
);

const QUEUE_NAME = "payment-success";
const CONCURRENCY = 1;

const runPaymentConsumer = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          const { paymentId, userId, dateId, amount, currency, payment_id } =
            job.data;

          // Create waitlist entry
          try {
            const newWaitlistEntry = new Waitlist({
              _id: uuidv4(),
              userId,
              dateId,
              paymentId,
              status: "waiting",
            });
            await newWaitlistEntry.save();
          } catch (err) {
            if (err.code === 11000) {
              console.log("Duplicate waitlist entry skipped:", {
                userId,
                dateId,
              });
            } else {
              throw err;
            }
          }

          // Fetch user profile
          const user = await Profile.findById(userId)
            .select("name email pushtoken")
            .lean();
          if (!user) {
            console.error("User not found:", userId);
            return;
          }

          // Fetch event date and city
          const eventDate = await EventDate.findById(dateId).lean();
          if (!eventDate) {
            console.error("Event date not found:", dateId);
            return;
          }
          const city = await VenueCity.findById(eventDate.city)
            .select("city_name timezone")
            .lean();
          if (!city) {
            console.error("City not found:", eventDate.city);
            return;
          }

          // Format event date
          const formattedDate = DateTime.fromJSDate(eventDate.date, {
            zone: "utc",
          })
            .setZone(city.timezone)
            .toLocaleString(DateTime.DATETIME_MED);

          // Send confirmation email
          await sendMessageToKafka("bulk-email", {
            to: user.email,
            subject: "Meet and More - Payment Confirmation & Waitlist",
            templateName: "payment-confirmation",
            data: {
              name: user.name || "User",
              amount,
              currency,
              paymentId: payment_id,
              eventDate: formattedDate,
              city: city.city_name,
            },
          });

          // Send push notification
          if (user.pushtoken) {
            await sendMessageToKafka("notification-batch", {
              tokens: [user.pushtoken],
              title: "Payment Successful!",
              body: `You're on the waitlist for the event in ${city.city_name} on ${formattedDate}.`,
              data: { paymentId: payment_id, dateId },
            });
          }

          // Create notification document
          await Notifications.create({
            _id: uuidv4(),
            userId,
            type: "message",
            message: {
              message: `Successfully registered and waitlisted for event in ${city.city_name} on ${formattedDate}.`,
              value: 0,
            },
            Requiresaction: false,
          });
        } catch (err) {
          console.error(`❌ Error processing job ${job.id}: ${err.message}`);
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-payment", {
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
        limiter: { max: 100, duration: 5000 },
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

runPaymentConsumer();
module.exports = { runPaymentConsumer };
