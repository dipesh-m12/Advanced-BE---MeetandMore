const mongoose = require("mongoose");
const redis = require("redis");
const cron = require("node-cron");
const Profile = require("../models/authModel");
const Referral = require("../models/ReferralCodeModel");
const { sendMessageToKafka } = require("./kafka");

// Initialize Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => console.error("Redis Client Error:", err));
redisClient.connect();

// Track if the cron job is scheduled
let isScheduled = false;

// Cron job to send nudges at 12:02 PM UTC daily (5:32 PM IST)
const scheduleNudgeJob = () => {
  if (isScheduled) {
    console.log(
      "Cron job is already scheduled to run at 12:02 PM UTC (5:32 PM IST)."
    );
    return;
  }

  cron.schedule(
    "2 12 * * *", // Runs at 12:02 PM UTC daily (5:32 PM IST)
    async () => {
      console.log("Running nudge users cron job at", new Date().toISOString());
      try {
        // Fetch users to exclude from Redis set
        const redisSetKey = "tracker-users";
        const excludedUserIds = await redisClient.sMembers(redisSetKey);

        // Count all active users for debugging
        const activeUsers = await Profile.countDocuments({
          deactivated: false,
          deleted: false,
        });

        // Fetch users
        const users = await Profile.aggregate([
          // Match active users not in the tracker set
          {
            $match: {
              deactivated: false,
              deleted: false,
              _id: { $nin: excludedUserIds },
            },
          },
          // Lookup referral code
          {
            $lookup: {
              from: Referral.collection.name,
              localField: "_id",
              foreignField: "userId",
              as: "referral",
              pipeline: [
                { $match: { type: "standard", status: "active" } },
                { $project: { code: 1 } },
              ],
            },
          },
          // Unwind referral (optional, preserves null if no referral)
          {
            $unwind: {
              path: "$referral",
              preserveNullAndEmptyArrays: true,
            },
          },
          // Add referral code field
          {
            $addFields: {
              referralCode: { $ifNull: ["$referral.code", ""] },
            },
          },
          // Project necessary fields
          {
            $project: {
              _id: 1,
              email: 1,
              name: 1,
              pushtoken: 1,
              hasAvailedFirstTimeDiscount: 1,
              referralCode: 1,
            },
          },
        ]);

        if (!users.length) {
          console.log("No users to nudge after filtering. Possible reasons:");
          console.log(`- Excluded users in Redis: ${excludedUserIds.length}`);
          console.log(`- Active users in DB: ${activeUsers}`);
          console.log(`- Check Profile data for deactivated/deleted status`);
          return;
        }

        for (const user of users) {
          try {
            // Prepare notification messages
            let pushTitle, pushBody, emailSubject, emailTemplate, emailData;

            if (!user.hasAvailedFirstTimeDiscount) {
              // User hasn't availed discount (no bookings)
              pushTitle = "Your First Event Awaits! 🌟";
              pushBody = user.referralCode
                ? `Hey ${user.name}, book your first event with Meet and More to claim your exclusive discount and share your referral code ${user.referralCode}!`
                : `Hey ${user.name}, book your first event with Meet and More to claim your exclusive discount!`;
              emailSubject =
                "Claim Your First-Time Discount with Meet and More!";
              emailTemplate = "nudge-first-event";
              emailData = {
                name: user.name || "User",
                referralCode: user.referralCode,
              };
            } else {
              // User has availed discount (has booked)
              pushTitle = "Meet More Amazing People! 🎉";
              pushBody = user.referralCode
                ? `Hey ${user.name}, check out our latest events to meet amazing people and share your referral code ${user.referralCode}!`
                : `Hey ${user.name}, check out our latest events to meet amazing people!`;
              emailSubject = "Discover More Events with Meet and More!";
              emailTemplate = "nudge-repeat-event";
              emailData = {
                name: user.name || "User",
                referralCode: user.referralCode,
              };
            }

            // Send push notification
            if (user.pushtoken) {
              await sendMessageToKafka("notification-batch", {
                tokens: [user.pushtoken],
                title: pushTitle,
                body: pushBody,
                data: {},
              });
            }

            // Send email
            await sendMessageToKafka("bulk-email", {
              to: user.email,
              subject: emailSubject,
              templateName: emailTemplate,
              data: emailData,
            });

            console.log(`Nudge sent to user ${user._id}`);
          } catch (err) {
            console.error(
              `Error processing nudge for user ${user._id}:`,
              err.message
            );
          }
        }

        console.log("Nudge users cron job completed");
      } catch (err) {
        console.error("Error in nudge users cron job:", err.message);
      }
    },
    {
      scheduled: true,
      timezone: "UTC",
    }
  );

  isScheduled = true;
  console.log("Cron job scheduled to run at 12:02 PM UTC (5:32 PM IST) daily.");
};
scheduleNudgeJob();
// Export the function to schedule the job
module.exports = scheduleNudgeJob;

// Ensure Redis client is closed on process exit
process.on("SIGINT", async () => {
  await redisClient.quit();
  process.exit(0);
});
