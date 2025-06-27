const cron = require("node-cron");
const redis = require("redis");
const { DateTime } = require("luxon");
const {
  invokeGroupAssignment,
  sendVenueNotifications,
  sendFollowUpEmails,
} = require("../consumers/groupAssignmentConsumer");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch((err) => console.error("Redis Client Error:", err));
redisClient.on("error", (err) => console.error("Redis Client Error:", err));

// In-memory map of active cron jobs
const cronJobs = new Map();

// --- Lock helpers using Redis SETNX ---
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

// --- Cleanup stale cron jobs ---
const cleanupStaleCronJobs = async () => {
  try {
    const keys = await redisClient.keys("cron:*");
    for (const key of keys) {
      const job = JSON.parse(await redisClient.get(key));
      if (
        DateTime.fromISO(job.scheduled).toMillis() < DateTime.now().toMillis()
      ) {
        await redisClient.del(key);
        const cronTask = cronJobs.get(`${job.task}:${job.dateId}`);
        if (cronTask) {
          cronTask.destroy();
          cronJobs.delete(`${job.task}:${job.dateId}`);
        }
      }
    }
  } catch (err) {
    console.error(`Error cleaning stale cron jobs: ${err.message}`);
  }
};
setInterval(cleanupStaleCronJobs, 24 * 60 * 60 * 1000); // Daily

// --- Schedule tasks for a specific dateId ---
const scheduleEventTasks = async (dateId, eventDate, timezone) => {
  try {
    const tasks = [
      {
        name: "group-assignment",
        func: invokeGroupAssignment,
        time: { hour: 22, minute: 0 },
        offsetDays: -1,
      },
      {
        name: "venue-notifications",
        func: sendVenueNotifications,
        time: { hour: 12, minute: 0 },
        offsetDays: 0,
      },
      {
        name: "follow-up-emails",
        func: sendFollowUpEmails,
        time: { hour: 23, minute: 59 },
        offsetDays: 0,
      },
    ];

    for (const task of tasks) {
      const cacheKey = `cron:${task.name}:${dateId}`;
      const lockKey = `lock:cron:${dateId}:${task.name}`;
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

        const date = DateTime.fromJSDate(eventDate, { zone: "utc" })
          .setZone(timezone)
          .plus({ days: task.offsetDays })
          .set(task.time);

        if (DateTime.now().setZone(timezone) > date) {
          console.log(
            `Task ${task.name} for dateId ${dateId} is in the past, skipping`
          );
          continue;
        }

        const cronExpression = `${date.second} ${date.minute} ${date.hour} ${date.day} ${date.month} *`;

        const cronTask = cron.schedule(
          cronExpression,
          async () => {
            try {
              console.log(`Running ${task.name} for dateId: ${dateId}`);
              await task.func(dateId);
              await redisClient.del(cacheKey);
              cronJobs.delete(`${task.name}:${dateId}`);
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

        cronJobs.set(`${task.name}:${dateId}`, cronTask);
        await redisClient.setEx(
          cacheKey,
          7 * 24 * 3600, // 7 days
          JSON.stringify({ dateId, task: task.name, scheduled: date.toISO() })
        );

        console.log(
          `Scheduled ${task.name} for dateId: ${dateId} at ${date.toISO()}`
        );
      } finally {
        await releaseLock(lockKey);
      }
    }
  } catch (err) {
    console.error(
      `Error scheduling tasks for dateId ${dateId}: ${err.message}`
    );
    throw err;
  }
};

module.exports = { scheduleEventTasks };
