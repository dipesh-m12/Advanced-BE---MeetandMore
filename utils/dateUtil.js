const mongoose = require("mongoose");
const { DateTime } = require("luxon");
const { v4: uuidv4 } = require("uuid");
const redis = require("redis");
const { scheduleEventTasks } = require("./cronScheduler");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch((err) => console.error("Redis Client Error:", err));
redisClient.on("error", (err) => console.error("Redis Client Error:", err));

const ensureFutureSaturdays = async (cityId, _, timezone) => {
  const EventDate = mongoose.model("EventDate");
  const now = DateTime.now().setZone(timezone);

  const allDates = await EventDate.find({
    city: cityId,
    isAvailable: true,
  })
    .sort({ date: 1 })
    .lean();

  const validDates = allDates.filter((d) => {
    const local = DateTime.fromJSDate(d.date, { zone: "utc" }).setZone(
      timezone
    );
    return (
      local.weekday === 6 &&
      local >= now &&
      now <= local.set({ hour: 12, minute: 0 })
    );
  });

  if (validDates.length >= 3) return;

  const needed = 3 - validDates.length;
  const datesToAdd = [];

  let candidate = now.startOf("day");

  while (datesToAdd.length < needed) {
    const nextSat = candidate.plus({ days: (6 - candidate.weekday + 7) % 7 });
    const saturday8pmLocal = nextSat.set({ hour: 20, minute: 0 });
    const regDeadline = saturday8pmLocal.set({ hour: 12, minute: 0 });

    if (saturday8pmLocal > now && now <= regDeadline) {
      const utcDate = saturday8pmLocal.toUTC().toJSDate();

      const alreadyExists = allDates.some(
        (d) =>
          DateTime.fromJSDate(d.date, { zone: "utc" }).toMillis() ===
          DateTime.fromJSDate(utcDate).toMillis()
      );

      if (!alreadyExists) {
        datesToAdd.push({ date: utcDate, id: uuidv4() });
      }
    }

    candidate = candidate.plus({ days: 7 });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const { date, id } of datesToAdd) {
        await EventDate.updateOne(
          { city: cityId, date },
          {
            $setOnInsert: {
              _id: id,
              city: cityId,
              date,
              isAvailable: true,
            },
          },
          { upsert: true, session }
        );
        await scheduleEventTasks(id, date, timezone);
      }
    });
  } catch (err) {
    console.error(
      `Error upserting event dates for cityId ${cityId}: ${err.message}`
    );
    throw err;
  } finally {
    session.endSession();
  }

  await redisClient.del(`event_dates:${cityId}`);
};

module.exports = { ensureFutureSaturdays };
