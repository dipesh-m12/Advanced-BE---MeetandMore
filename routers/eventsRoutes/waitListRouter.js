const express = require("express");
const verifyJWT = require("../../middlewares/verifyJWT");
const Waitlist = require("../../models/waitlistModel");
const { v4: uuidv4 } = require("uuid");

const waitlistRouter = express.Router();

// GET /api/waitlist/my-dates - Get date IDs where user is waitlisted or confirmed
waitlistRouter.get("/my-dates", verifyJWT, async (req, res) => {
  try {
    const userId = req.user.uuid;

    // Fetch waitlist entries for user with status "waiting" or "confirmed"
    const waitlistEntries = await Waitlist.find(
      { userId, status: { $in: ["waiting", "confirmed", "completed"] } },
      "dateId status"
    ).lean();

    if (!waitlistEntries.length) {
      return res.status(200).json({
        success: true,
        message: "No waitlisted or confirmed dates found",
        data: [],
      });
    }

    // Map to return dateId and status
    const dates = waitlistEntries.map((entry) => ({
      dateId: entry.dateId,
      status: entry.status,
    }));

    return res.status(200).json({
      success: true,
      message: "Waitlisted and confirmed dates retrieved",
      data: dates,
    });
  } catch (err) {
    console.error("Error fetching waitlist dates:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dates: " + (err.message || "Unknown error"),
      data: null,
    });
  }
});

module.exports = waitlistRouter;
