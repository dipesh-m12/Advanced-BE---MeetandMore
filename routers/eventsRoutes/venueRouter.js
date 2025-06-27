const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { VenueCity, Venue } = require("../../models/eventModel");
const { v4: uuidv4 } = require("uuid");
// const verifyJWT = require("../../middlewares/verifyJWT");
const { verifyAdmin } = require("../../middlewares/verifyAdminJWT");
const currencies = require("../../utils/data");
const venueRouter = express.Router();
const redis = require("redis");
const { EventDate } = require("../../models/DateModel");
const Waitlist = require("../../models/waitlistModel");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

venueRouter.use(verifyAdmin);

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

// VenueCity Routes
// Cache key for cities
const CITIES_CACHE_KEY = "venue_cities";

// Function to invalidate cache
const invalidateCitiesCache = async () => {
  try {
    await redisClient.del(CITIES_CACHE_KEY);
  } catch (err) {
    console.error("Error invalidating cache:", err.message);
  }
};

// GET /api/venues/cities - Get all cities with caching
venueRouter.get("/cities", async (req, res) => {
  try {
    // Check cache first
    const cachedCities = await redisClient.get(CITIES_CACHE_KEY);
    if (cachedCities) {
      return res.status(200).json({
        success: true,
        message: "Cities fetched successfully (from cache)",
        data: JSON.parse(cachedCities),
      });
    }

    // Fetch from database if not in cache
    const cities = await VenueCity.find()
      .lean()
      .select("amount city_name _id region_currency timezone");

    // Store in cache with a 1-hour expiration
    await redisClient.setEx(CITIES_CACHE_KEY, 3600, JSON.stringify(cities));

    return res.status(200).json({
      success: true,
      message: "Cities fetched successfully",
      data: cities,
    });
  } catch (err) {
    console.error("Error fetching cities:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cities",
      data: null,
    });
  }
});

// POST /api/venues/cities - Add a new city
venueRouter.post(
  "/cities",
  [
    body("city_name").notEmpty().withMessage("City name is required").trim(),
    body("region_currency")
      .isIn(currencies)
      .withMessage("Invalid region currency"),
    body("amount")
      .isFloat({ min: 0 })
      .withMessage("Amount must be a non-negative number"),
    body("timezone").notEmpty().withMessage("Timezone is required"), // Add timezone validation
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { city_name, region_currency, amount, timezone } = req.body;

      const existingCity = await VenueCity.findOne({ city_name });
      if (existingCity) {
        return res.status(409).json({
          success: false,
          message: "City already exists",
          data: null,
        });
      }

      const newCity = await VenueCity.create({
        _id: uuidv4(),
        city_name,
        region_currency,
        amount,
        timezone, // Include timezone
      });

      await invalidateCitiesCache();

      return res.status(201).json({
        success: true,
        message: "City added successfully",
        data: newCity,
      });
    } catch (err) {
      console.error("Error adding city:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to add city",
        data: null,
      });
    }
  }
);

// DELETE /api/venues/cities/:cityId - Remove a city
venueRouter.delete(
  "/cities/:cityId",
  [param("cityId").notEmpty().withMessage("City ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { cityId } = req.params;

      const city = await VenueCity.findById(cityId);
      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      const venues = await Venue.countDocuments({ city: cityId });
      if (venues > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot delete city with associated venues",
          data: null,
        });
      }

      await VenueCity.deleteOne({ _id: cityId });

      // Invalidate cache after deleting a city
      await invalidateCitiesCache();

      return res.status(200).json({
        success: true,
        message: "City removed successfully",
        data: null,
      });
    } catch (err) {
      console.error("Error removing city:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to remove city",
        data: null,
      });
    }
  }
);

// PATCH /api/venues/cities/:cityId/amount - Change amount for a city
venueRouter.patch(
  "/cities/:cityId",
  [
    param("cityId").notEmpty().withMessage("City ID is required"),
    body("amount")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Amount must be a non-negative number"),
    body("timezone")
      .optional()
      .notEmpty()
      .withMessage("Timezone cannot be empty"), // Optional timezone update
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { cityId } = req.params;
      const { amount, timezone } = req.body;

      const updateFields = {};
      if (amount !== undefined) updateFields.amount = amount;
      if (timezone !== undefined) updateFields.timezone = timezone;

      const city = await VenueCity.findByIdAndUpdate(cityId, updateFields, {
        new: true,
        runValidators: true,
      });

      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      await invalidateCitiesCache();

      return res.status(200).json({
        success: true,
        message: "City updated successfully",
        data: city,
      });
    } catch (err) {
      console.error("Error updating city:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to update city",
        data: null,
      });
    }
  }
);

// Venue Routes

// POST /api/venues - Add a new venue
venueRouter.post(
  "/venues",
  [
    body("city").notEmpty().withMessage("City ID is required"),
    body("address").notEmpty().withMessage("Address is required").trim(),
    body("name").notEmpty().withMessage("Name is required").trim(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { city, address, name } = req.body;

      const cityExists = await VenueCity.findById(city);
      if (!cityExists) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      const newVenue = await Venue.create({
        _id: uuidv4(),
        city,
        address,
        name,
        active: false, // New venues start as inactive
      });

      return res.status(201).json({
        success: true,
        message: "Venue added successfully",
        data: newVenue,
      });
    } catch (err) {
      if (err.code === 11000) {
        const duplicateField = Object.keys(err.keyPattern)[0];
        return res.status(400).json({
          success: false,
          message: `A venue with this ${duplicateField} already exists.`,
          data: null,
        });
      }
      console.error("Error adding venue:", err.message);

      return res.status(500).json({
        success: false,
        message: "Failed to add venue",
        data: null,
      });
    }
  }
);

// DELETE /api/venues/:venueId - Remove a venue
venueRouter.delete(
  "/venues/:venueId",
  [param("venueId").notEmpty().withMessage("Venue ID is required")],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: errors.array()[0].msg,
          data: null,
        });
      }

      const { venueId } = req.params;

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({
          success: false,
          message: "Venue not found",
          data: null,
        });
      }

      // Check if venue is inactive
      if (venue.active) {
        return res.status(400).json({
          success: false,
          message: "Cannot delete an active venue",
          data: null,
        });
      }

      // Check if future booking is not prevented
      if (!venue.preventFutureBooking) {
        return res.status(400).json({
          success: false,
          message: "Cannot delete a venue with future bookings allowed",
          data: null,
        });
      }

      // Check for active waitlists
      const futureEvents = await EventDate.find({
        city: venue.city,
        date: { $gte: new Date() },
      }).lean();

      const eventIds = futureEvents.map((event) => event._id);

      const waitlistCount = await Waitlist.countDocuments({
        dateId: { $in: eventIds },
        status: { $in: ["waiting", "confirmed"] },
      });

      if (waitlistCount > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot delete venue with waiting or confirmed waitlists",
          data: null,
        });
      }

      await Venue.deleteOne({ _id: venueId });

      return res.status(200).json({
        success: true,
        message: "Venue removed successfully",
        data: null,
      });
    } catch (err) {
      console.error("Error removing venue:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to remove venue",
        data: null,
      });
    }
  }
);

// GET /api/venues/city/:cityId - Get venues by city
venueRouter.get(
  "/city/:cityId",
  [param("cityId").notEmpty().withMessage("City ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { cityId } = req.params;

      const cityExists = await VenueCity.findById(cityId);
      if (!cityExists) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      const venues = await Venue.find({
        city: cityId,
        // active: true,
        // preventFutureBooking: false,
      }).lean();
      // const venues = await Venue.find({
      //   city: cityId,
      //   active: true,
      //   preventFutureBooking: false,
      // }).lean();

      return res.status(200).json({
        success: true,
        message: "Venues fetched successfully",
        data: venues,
      });
    } catch (err) {
      console.error("Error fetching venues:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch venues",
        data: null,
      });
    }
  }
);

// PATCH /api/venues/:venueId/toggle-status - Toggle venue status
venueRouter.patch(
  "/:venueId/toggle-status",
  [param("venueId").notEmpty().withMessage("Venue ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { venueId } = req.params;

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({
          success: false,
          message: "Venue not found",
          data: null,
        });
      }

      const newStatus = !venue.active;

      if (!newStatus) {
        // Deactivating: Ensure preventFutureBooking is true
        if (!venue.preventFutureBooking) {
          return res.status(400).json({
            success: false,
            message:
              "Cannot deactivate venue until future bookings are prevented",
            data: null,
          });
        }

        // Check for active waitlists
        const futureEvents = await EventDate.find({
          city: venue.city,
          date: { $gte: new Date() },
        }).lean();

        const eventIds = futureEvents.map((event) => event._id);

        const waitlistCount = await Waitlist.countDocuments({
          dateId: { $in: eventIds },
          status: { $in: ["waiting", "confirmed"] },
        });

        if (waitlistCount > 0) {
          return res.status(400).json({
            success: false,
            message:
              "Cannot deactivate venue with waiting or confirmed waitlists",
            data: null,
          });
        }
      }

      if (newStatus) {
        // Activating: Deactivate other venues in the same city
        await Venue.deactivateOtherVenues(venue.city, venueId);
      }

      venue.active = newStatus;
      await venue.save();

      return res.status(200).json({
        success: true,
        message: `Venue ${
          newStatus ? "activated" : "deactivated"
        } successfully`,
        data: venue,
      });
    } catch (err) {
      console.error("Error toggling venue status:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to toggle venue status",
        data: null,
      });
    }
  }
);

// PATCH /api/venues/:venueId/toggle-future-booking
venueRouter.patch(
  "/:venueId/toggle-future-booking",
  [param("venueId").notEmpty().withMessage("Venue ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { venueId } = req.params;

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({
          success: false,
          message: "Venue not found",
          data: null,
        });
      }

      const newPreventStatus = !venue.preventFutureBooking;

      if (!newPreventStatus && !venue.active) {
        return res.status(400).json({
          success: false,
          message: "Cannot allow future booking for inactive venue",
          data: null,
        });
      }

      venue.preventFutureBooking = newPreventStatus;
      await venue.save();

      return res.status(200).json({
        success: true,
        message: `Future booking ${
          newPreventStatus ? "prevented" : "allowed"
        } successfully`,
        data: venue,
      });
    } catch (err) {
      console.error("Error toggling future booking status:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to toggle future booking status",
        data: null,
      });
    }
  }
);

module.exports = venueRouter;
