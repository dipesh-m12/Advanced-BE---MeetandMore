const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const redis = require("redis");
const verifyJWT = require("../middlewares/verifyJWT"); // Assuming you have this middleware

// Initialize Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("error", (err) => console.error("Redis Client Error:", err));
redisClient.connect();

// Route to add user to tracker set
router.post(
  "/add-to-tracker",
  verifyJWT, // Add JWT verification middleware
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array(),
      });
    }

    try {
      const userId = req.user.uuid; // Assuming verifyJWT sets req.user with a uuid field

      // Add userId to Redis set
      const redisSetKey = "tracker-users";
      await redisClient.sAdd(redisSetKey, userId);

      // Set expiration for the set (1 days) to prevent indefinite growth
      await redisClient.expire(redisSetKey, 1 * 24 * 60 * 60);

      return res.status(200).json({
        success: true,
        message: "User added to tracker set",
        data: null,
      });
    } catch (err) {
      console.error("Error adding user to tracker set:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to add user to tracker set",
        data: null,
      });
    }
  }
);

module.exports = router;
