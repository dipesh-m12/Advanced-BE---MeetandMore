const mongoose = require("mongoose");
const cron = require("node-cron");
const { DateTime } = require("luxon");
const redis = require("redis");
const {
  invokeGroupAssignment,
  sendVenueNotifications,
  sendFollowUpEmails,
} = require("../consumers/groupAssignmentConsumer");
require("dotenv").config();

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch((err) => console.error("Redis Client Error:", err));
redisClient.on("error", (err) => console.error("Redis Client Error:", err));

// Store cron jobs in memory
const cronJobs = new Map();

// Manual Redis locking
const acquireLock = async (key, ttl = 10000) => {
  const result = await redisClient.set(key, "locked", {
    NX: true,
    PX: ttl,
  });
  return result === "OK";
};

const releaseLock = async (key) => {
  await redisClient.del(key);
};

// Main function
async function testServicesCron(startTime, dateId) {
  try {
    if (!startTime || !dateId) {
      throw new Error("startTime and dateId are required");
    }

    const startDateTime = DateTime.fromISO(startTime, { setZone: true });
    if (!startDateTime.isValid) {
      throw new Error(
        "Invalid startTime format, expected ISO (e.g., 2025-06-08T18:30:00+05:30)"
      );
    }

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI);
    }

    const eventDate = await mongoose.model("EventDate").findById(dateId).lean();
    if (!eventDate) {
      throw new Error(`EventDate not found for dateId: ${dateId}`);
    }

    const venueCity = await mongoose
      .model("VenueCity")
      .findById(eventDate.city)
      .select("timezone")
      .lean();
    if (!venueCity) {
      throw new Error(`VenueCity not found for cityId: ${eventDate.city}`);
    }

    const timezone = venueCity.timezone;
    const now = DateTime.now().setZone(timezone);
    if (startDateTime.setZone(timezone) <= now) {
      throw new Error(
        `startTime ${startTime} is in the past for timezone ${timezone}`
      );
    }

    const tasks = [
      {
        name: "group-assignment",
        func: invokeGroupAssignment,
        offsetMinutes: 0,
      },
      {
        name: "venue-notifications",
        func: sendVenueNotifications,
        offsetMinutes: 3,
      },
      {
        name: "follow-up-emails",
        func: sendFollowUpEmails,
        offsetMinutes: 6,
      },
    ];

    for (const task of tasks) {
      const cacheKey = `cron:test:${task.name}:${dateId}`;
      const lockKey = `lock:cron:test:${dateId}:${task.name}`;
      const gotLock = await acquireLock(lockKey, 10000);

      if (!gotLock) {
        console.log(
          `Could not acquire lock for ${task.name} on dateId ${dateId}`
        );
        continue;
      }

      try {
        const existingJob = await redisClient.get(cacheKey);
        if (existingJob) {
          console.log(
            `Cron job ${task.name} already scheduled for dateId: ${dateId}`
          );
          continue;
        }

        const scheduleTime = startDateTime
          .plus({ minutes: task.offsetMinutes })
          .setZone(timezone);

        const cronExpression = `${scheduleTime.second} ${scheduleTime.minute} ${scheduleTime.hour} ${scheduleTime.day} ${scheduleTime.month} *`;

        const cronTask = cron.schedule(
          cronExpression,
          async () => {
            try {
              console.log(
                `Running ${
                  task.name
                } for dateId: ${dateId} at ${scheduleTime.toISO()}`
              );
              await task.func(dateId);
              await redisClient.del(cacheKey);
              cronJobs.delete(cacheKey);
              cronTask.destroy();
              console.log(
                `Cron job ${task.name} for dateId: ${dateId} completed and removed`
              );
            } catch (err) {
              console.error(
                `Error in cron job ${task.name} for dateId ${dateId}: ${err.message}`
              );
            }
          },
          {
            scheduled: true,
            timezone,
          }
        );

        cronJobs.set(cacheKey, cronTask);
        await redisClient.setEx(
          cacheKey,
          3600, // 1 hour
          JSON.stringify({
            dateId,
            task: `test:${task.name}`,
            scheduledTime: scheduleTime.toISO(),
          })
        );

        console.log(
          `Scheduled ${
            task.name
          } for dateId: ${dateId} at ${scheduleTime.toISO()} in timezone ${timezone}`
        );
      } finally {
        await releaseLock(lockKey);
      }
    }
  } catch (err) {
    console.error(
      `Error scheduling test services for dateId ${dateId}: ${err.message}`
    );
    throw err;
  }
}

// Example usage: node testServicesCron.js <startTime> <dateId>
if (require.main === module) {
  const startTime = process.argv[2];
  const dateId = process.argv[3];
  testServicesCron(startTime, dateId).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { testServicesCron };
