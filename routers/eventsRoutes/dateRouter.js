const express = require("express");
const { query, validationResult, body } = require("express-validator");
const { EventDate } = require("../../models/DateModel");
const { VenueCity } = require("../../models/eventModel");
const { Preference } = require("../../models/PreferenceModel");
const verifyJWT = require("../../middlewares/verifyJWT");
const { DateTime } = require("luxon");
const { ensureFutureSaturdays } = require("../../utils/dateUtil");
const redis = require("redis");
// +++ Import cron scheduler
const { scheduleEventTasks } = require("../../utils/cronScheduler");

const datesRouter = express.Router();
datesRouter.use(verifyJWT);

// Initialize Redis client
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);
redisClient.on("error", (err) => console.error("Redis Client Error:", err));

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

datesRouter.get(
  "/",
  [query("cityId").notEmpty().withMessage("City ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { cityId } = req.query;

      // Cache key for city dates
      const cacheKey = `event_dates:${cityId}`;

      const city = await VenueCity.findById(cityId).select("timezone").lean();
      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      const timezone = city.timezone;
      const now = DateTime.now().setZone(timezone);
      const today = now.startOf("day").toUTC().toJSDate();

      // Check Redis cache
      const cachedData = await redisClient.get(cacheKey);
      if (cachedData) {
        const parsed = JSON.parse(cachedData);
        const validCachedDates = parsed.data.filter((d) => {
          const local = DateTime.fromISO(d.date, { zone: timezone });
          const deadline = local.set({ hour: 12, minute: 0 });
          return now <= deadline && local.weekday === 6;
        });
        if (validCachedDates.length >= 3) {
          return res.status(200).json({
            success: true,
            message: "Future Saturdays fetched successfully",
            data: validCachedDates.slice(0, 3),
            timezone: parsed.timezone,
          });
        }
        await redisClient.del(cacheKey);
      }

      // Fetch from database and schedule cron jobs
      await ensureFutureSaturdays(cityId, today, timezone);

      const dates = await EventDate.find({
        city: cityId,
        date: { $gte: today },
        isAvailable: true,
      })
        .sort({ date: 1 })
        .lean();

      const filteredDates = dates
        .filter((d) => {
          const local = DateTime.fromJSDate(d.date, { zone: "utc" }).setZone(
            timezone
          );
          const deadline = local.set({ hour: 12, minute: 0 });
          return now <= deadline && local.weekday === 6;
        })
        .slice(0, 3);

      const formattedDates = filteredDates.map((d) => ({
        _id: d._id,
        city: d.city,
        date: DateTime.fromJSDate(d.date, { zone: "utc" })
          .setZone(timezone)
          .set({ hour: 20, minute: 0, second: 0, millisecond: 0 })
          .toISO(),
        isAvailable: d.isAvailable,
      }));

      const cacheData = {
        data: formattedDates,
        timezone,
      };

      const response = {
        success: true,
        message: "Future Saturdays fetched successfully",
        data: formattedDates,
        timezone,
      };

      // Cache data for 10 minutes
      await redisClient.setEx(cacheKey, 600, JSON.stringify(cacheData));

      return res.status(200).json(response);
    } catch (err) {
      console.error(
        `Error fetching dates for cityId ${req.query.cityId}: ${err.message}`
      );
      return res.status(500).json({
        success: false,
        message: "Failed to fetch dates",
        data: null,
      });
    }
  }
);

datesRouter.post(
  "/preferences",
  [body("dateId").notEmpty().withMessage("Date ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const {
        dateId,
        dietaryRestriction,
        enjoyFood,
        willingToSpend,
        idealDinnerTime,
      } = req.body;
      const userId = req.user.uuid;

      const preference = await Preference.findOneAndUpdate(
        { userId, dateId },
        { dietaryRestriction, enjoyFood, willingToSpend, idealDinnerTime },
        { upsert: true, new: true }
      );

      return res.status(200).json({
        success: true,
        message: "Preferences saved",
        data: preference,
      });
    } catch (err) {
      console.error("Error saving preferences:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to save preferences",
        data: null,
      });
    }
  }
);

datesRouter.get(
  "/preferences",
  [query("dateId").notEmpty().withMessage("Date ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { dateId } = req.query;
      const userId = req.user.uuid;

      const preference = await Preference.findOne({ userId, dateId }).lean();
      if (!preference) {
        return res.status(404).json({
          success: false,
          message: "Preferences not found",
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Preferences fetched",
        data: preference,
      });
    } catch (err) {
      console.error("Error fetching preferences:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch preferences",
        data: null,
      });
    }
  }
);

module.exports = datesRouter;
