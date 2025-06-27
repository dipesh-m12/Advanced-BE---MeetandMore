const express = require("express");
const axios = require("axios");
const Profile = require("../models/authModel");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcryptjs");
const locationRouter = express.Router();
const verifyJWT = require("../middlewares/verifyJWT");
const { body, query, validationResult } = require("express-validator");
const admin = require("firebase-admin");
const redis = require("redis");
const { sendMessageToKafka } = require("../utils/kafka");
const { University, City } = require("../models/serviceModel");

const serviceAccount = require("../files/meet-and-more-firebase-adminsdk-fbsvc-3f48c560cb.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch((err) => {
  console.error("Redis connection error:", err);
});

const safeRedis = async (fn, operationName) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error in ${operationName}:`, err);
    throw err;
  }
};

locationRouter.get(
  "/search-cities",
  [
    query("query")
      .notEmpty()
      .withMessage("Query parameter 'query' is required")
      .trim()
      .isLength({ min: 1 })
      .withMessage("Query parameter 'query' cannot be empty"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        data: [],
      });
    }

    const { query } = req.query;
    const redisKey = `cities:${query.toLowerCase()}`;

    try {
      // Try getting from cache first
      const cached = await safeRedis(
        () => redisClient.get(redisKey),
        `read ${redisKey}`
      );
      if (cached) {
        return res.json({
          success: true,
          data: JSON.parse(cached),
          message: "Cities fetched from cache!",
        });
      }

      // Query local City model with case-insensitive regex, limit to 10
      const results = await City.find({
        name: { $regex: query, $options: "i" }, // Case-insensitive partial match
      })
        .select("name country") // Only fetch the name field
        .limit(10) // Limit to 10 results
        .lean()
        .then((docs) =>
          docs.map((item) => ({ name: item.name, country_code: item.country }))
        );

      // Cache for 12 hours (43200 seconds)
      await safeRedis(
        () => redisClient.setEx(redisKey, 43200, JSON.stringify(results)),
        `cache ${redisKey}`
      );

      res.json({
        success: true,
        data: results,
        message: "Cities fetched successfully!",
      });
    } catch (err) {
      console.error("City search error:", err.message);
      res.status(500).json({
        success: false,
        message: "Failed to fetch cities",
        data: [],
      });
    }
  }
);

// GET /api/universities?q=oxford
locationRouter.get(
  "/universities",
  // verifyJWT,
  [
    query("q")
      .notEmpty()
      .withMessage("Query string 'q' is required")
      .trim()
      .isLength({ min: 1 })
      .withMessage("Query string 'q' cannot be empty"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        data: [],
      });
    }

    const { q } = req.query;
    const redisKey = `universities:${q.toLowerCase().trim()}`;

    try {
      // Check Redis cache
      const cached = await safeRedis(
        () => redisClient.get(redisKey),
        `read ${redisKey}`
      );
      if (cached) {
        return res.status(200).json({
          success: true,
          message: "Universities fetched from cache",
          data: JSON.parse(cached),
        });
      }

      // Query local University model with case-insensitive regex, limit to 10
      const localResults = await University.find({
        name: { $regex: q, $options: "i" }, // Case-insensitive partial match
      })
        .limit(10) // Limit local results to 10
        .lean();

      // Fetch from external API, limit to 10
      let externalResults = [];
      try {
        const response = await axios.get(
          `http://universities.hipolabs.com/search?name=${encodeURIComponent(
            q
          )}`
        );
        externalResults = response.data
          .slice(0, 10)
          .map((item) => ({ name: item.name })); // Limit to 10
      } catch (apiErr) {
        console.warn("External API error:", apiErr.message);
      }

      // Combine and deduplicate results, limit to 20
      const combinedResults = [
        ...localResults.map((item) => ({ name: item.name })),
        ...externalResults,
      ];
      const uniqueResults = Array.from(
        new Set(combinedResults.map((item) => item.name))
      )
        .map((name) => ({ name }))
        .slice(0, 20); // Final limit to 20

      // Cache result for 12 hours
      await safeRedis(
        () => redisClient.setEx(redisKey, 43200, JSON.stringify(uniqueResults)),
        `cache ${redisKey}`
      );

      return res.status(200).json({
        success: true,
        message: "Universities fetched successfully",
        data: uniqueResults,
      });
    } catch (err) {
      console.error("Error fetching universities:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch universities",
        data: [],
      });
    }
  }
);

//Email availability status
locationRouter.get(
  "/emailAvailable",
  [query("email").isEmail().withMessage("Valid email required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        data: null,
      });
    }

    try {
      const { email } = req.query;

      // Check for active profile only (deleted: false)
      const existingProfile = await Profile.findOne({
        email,
        deleted: false,
      }).lean();

      if (existingProfile) {
        return res.status(200).json({
          success: true,
          message: "Email is already in use",
          data: { isAvailable: false },
        });
      }

      return res.status(200).json({
        success: true,
        message: "Email is available",
        data: { isAvailable: true },
      });
    } catch (err) {
      console.error("Email availability check error:", err.message, err.stack);
      return res.status(500).json({
        success: false,
        message: "Failed to check email availability",
        data: null,
      });
    }
  }
);

// POST /api/auth/usernames
locationRouter.post(
  "/usernames",
  verifyJWT,
  [
    body("ids")
      .isArray({ min: 1 })
      .withMessage("IDs must be a non-empty array of UUIDs"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { ids } = req.body;
    try {
      const usernames = {};
      const idsToFetchFromDb = [];

      // Check Redis for cached usernames
      for (const id of ids) {
        const cachedName = await redisClient.get(`profile:name:${id}`);
        if (cachedName) usernames[id] = cachedName;
        else idsToFetchFromDb.push(id);
      }

      // Fetch from DB if not in Redis
      if (idsToFetchFromDb.length > 0) {
        const profiles = await Profile.find({
          _id: { $in: idsToFetchFromDb },
        }).select("name");
        const multi = redisClient.multi();
        profiles.forEach((profile) => {
          usernames[profile._id] = profile.name;
          multi.setEx(`profile:name:${profile._id}`, 86400, profile.name); // Cache for 1 day
        });
        await multi.exec();
      }

      return res.status(200).json({
        success: true,
        message: "Usernames fetched successfully",
        data: usernames,
      });
    } catch (err) {
      console.error("Error fetching usernames:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch usernames",
        data: null,
      });
    }
  }
);

// POST /api/notify
locationRouter.post(
  "/notify",
  verifyJWT,
  [
    body("fcmToken").notEmpty().withMessage("FCM token is required"),
    body("title").notEmpty().withMessage("Title is required"),
    body("body").notEmpty().withMessage("Body is required"),
    body("data").optional().isObject().withMessage("Data must be an object"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
      });
    }

    const { fcmToken, title, body: msgBody, data } = req.body;

    const message = {
      token: fcmToken,
      notification: {
        title,
        body: msgBody,
      },
      data: data || {},
    };

    try {
      const response = await admin.messaging().send(message);
      return res.status(200).json({
        success: true,
        message: "Notification sent successfully",
        responseId: response,
      });
    } catch (err) {
      console.error("FCM error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to send notification",
      });
    }
  }
);

//for messages
//batch notify
locationRouter.post(
  "/notifyBatch",
  verifyJWT,
  [
    body("userIds")
      .isArray({ min: 1 })
      .withMessage("userIds must be a non-empty array")
      .custom((arr) => arr.every((id) => typeof id === "string" && id.trim()))
      .withMessage("userIds must contain valid strings"),
    body("title").notEmpty().withMessage("Title is required"),
    body("body").notEmpty().withMessage("Body is required"),
    body("data").optional().isObject().withMessage("Data must be an object"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        data: null,
      });
    }

    const { userIds, title, body: msgBody, data } = req.body;

    try {
      const pipeline = redisClient.multi();
      userIds.forEach((id) => pipeline.sIsMember("onlineUsers", id));
      const results = await safeRedis(
        () => pipeline.exec(),
        "check online status"
      );

      const offlineUserIds = userIds.filter((id, index) => !results[index]);
      if (offlineUserIds.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No offline users to notify",
          data: { queued: 0 },
        });
      }

      const redisKeys = offlineUserIds.map((id) => `notifications:${id}`);
      const cachedTokens = await safeRedis(
        () => redisClient.mGet(redisKeys),
        `fetch tokens for ${offlineUserIds.length} users`
      );

      const tokensMap = new Map();
      const missingIds = [];

      offlineUserIds.forEach((id, index) => {
        if (cachedTokens[index]) {
          tokensMap.set(id, cachedTokens[index]);
        } else {
          missingIds.push(id);
        }
      });

      if (missingIds.length > 0) {
        const profiles = await Profile.find(
          { _id: { $in: missingIds } },
          "pushtoken"
        ).lean();
        const multi = redisClient.multi();
        profiles.forEach((profile) => {
          if (profile.pushtoken) {
            tokensMap.set(profile._id.toString(), profile.pushtoken);
            multi.setEx(
              `notifications:${profile._id}`,
              604800,
              profile.pushtoken
            );
          }
        });
        await safeRedis(
          () => multi.exec(),
          `cache tokens for ${profiles.length} users`
        );
      }

      const validTokens = [...tokensMap.values()].filter((token) => token);
      if (validTokens.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No valid FCM tokens found",
          data: { queued: 0 },
        });
      }
      // console.log(validTokens);
      await sendMessageToKafka("notification-batch", {
        tokens: validTokens,
        title,
        body: msgBody,
        data: data || {},
      });

      return res.status(200).json({
        success: true,
        message: "Notifications enqueued for offline users",
        data: { queued: validTokens.length },
      });
    } catch (err) {
      console.error("Batch notify error:", err);
      res.status(500).json({
        success: false,
        message: "Failed to enqueue batch notifications",
        data: null,
      });
    }
  }
);

//forgot password
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Forgot Password - Generate OTP
locationRouter.post(
  "/forgot-password",
  [body("email").isEmail().withMessage("Valid email required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        data: null,
      });
    }

    try {
      const { email } = req.body;
      const user = await Profile.findOne({ email, deleted: false }).lean();

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "No active user found with this email",
          data: null,
        });
      }

      const sessionId = uuidv4();
      const code = generateOTP();

      await safeRedis(
        () =>
          redisClient.setEx(
            `forgotPass:${sessionId}`,
            300, // 5-minute TTL
            JSON.stringify({
              code,
              email,
              userId: user._id,
              attempts: 0,
            })
          ),
        `store forgotPass:${sessionId}`
      );

      // 📧 Send email using template
      await sendMessageToKafka("bulk-email", {
        to: email,
        subject: "Your Meet and More Verification Code 🔐",
        templateName: "verification-code",
        data: {
          name: user.name || "there",
          code,
        },
      });

      return res.status(200).json({
        success: true,
        message: "Verification code sent",
        data: { sessionId },
      });
    } catch (err) {
      console.error("Forgot password error:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to initiate password reset",
        data: null,
      });
    }
  }
);

// Verify OTP and Update Password
locationRouter.post(
  "/verify-forgot-password",
  [
    body("sessionId").isUUID().withMessage("Valid session ID required"),
    body("code")
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        data: null,
      });
    }

    const { sessionId, code, password } = req.body;

    try {
      const stored = await safeRedis(
        () => redisClient.get(`forgotPass:${sessionId}`),
        `fetch forgotPass:${sessionId}`
      );

      if (!stored) {
        return res.status(400).json({
          status: false,
          message: "Session expired or not found",
          data: null,
        });
      }

      const { code: savedCode, userId, email, attempts } = JSON.parse(stored);

      const newAttempts = attempts + 1;
      if (newAttempts > 3) {
        await safeRedis(
          () => redisClient.del(`forgotPass:${sessionId}`),
          `delete forgotPass:${sessionId}`
        );
        return res.status(400).json({
          success: false,
          message: "Maximum verification attempts exceeded",
          data: null,
        });
      }

      await safeRedis(
        () =>
          redisClient.setEx(
            `forgotPass:${sessionId}`,
            300,
            JSON.stringify({
              code: savedCode,
              email,
              userId,
              attempts: newAttempts,
            })
          ),
        `update forgotPass:${sessionId}`
      );

      if (savedCode !== code) {
        return res.status(400).json({
          success: false,
          message: "Invalid verification code",
          data: null,
        });
      }

      const user = await Profile.findById(userId);
      if (!user || user.deleted || user.deactivated) {
        return res.status(403).json({
          success: false,
          message: "Account is deactivated or deleted",
          data: null,
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      user.password = hashedPassword;
      await user.save();

      await safeRedis(
        () => redisClient.del(`forgotPass:${sessionId}`),
        `delete forgotPass:${sessionId}`
      );

      return res.status(200).json({
        success: true,
        message: "Password updated successfully",
        data: null,
      });
    } catch (err) {
      console.error("Verify forgot password error:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to verify and update password",
        data: null,
      });
    }
  }
);

module.exports = locationRouter;
