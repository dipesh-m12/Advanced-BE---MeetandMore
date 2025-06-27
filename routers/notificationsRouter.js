const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const Profile = require("../models/authModel");
const Notifications = require("../models/notisModel.js");
const verifyJWT = require("../middlewares/verifyJWT");
const { body, validationResult, param } = require("express-validator");
const socialSigninRouter = require("./socialSignInRouter");
const redis = require("redis");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const notisRouter = express.Router();

// Safe Redis helper
const safeRedis = async (fn, operationName) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error in ${operationName}:`, err);
    throw err;
  }
};

notisRouter.use(verifyJWT);

// Add Notification
notisRouter.post(
  "/add",
  [
    body("type")
      .exists()
      .withMessage("Type is required")
      .isIn(["message", "rateExp", "anotherDinner"])
      .withMessage("Type must be message, rateExp, or anotherDinner"),
    body("message")
      .exists()
      .withMessage("Message text is required")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("Message text cannot be empty"),
    body("messageValue")
      .optional()
      .isNumeric()
      .withMessage("Message value must be a number"),
    body("RateExp.message")
      .if(body("type").equals("rateExp"))
      .exists()
      .withMessage("RateExp message is required for type rateExp")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("RateExp message cannot be empty"),
    body("RateExp.value")
      .if(body("type").equals("rateExp"))
      .exists()
      .withMessage("RateExp value is required for type rateExp")
      .isNumeric()
      .withMessage("RateExp value must be a number"),
    body("Anotherdinner.message")
      .if(body("type").equals("anotherDinner"))
      .exists()
      .withMessage("Anotherdinner message is required for type anotherDinner")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("Anotherdinner message cannot be empty"),
    body("Anotherdinner.value")
      .if(body("type").equals("anotherDinner"))
      .exists()
      .withMessage("Anotherdinner value is required for type anotherDinner")
      .isBoolean()
      .withMessage("Anotherdinner value must be a boolean"),
    body("Requiresaction")
      .if(body("type").isIn(["rateExp", "anotherDinner"]))
      .exists()
      .withMessage("Requiresaction is required for rateExp or anotherDinner")
      .isBoolean()
      .withMessage("Requiresaction must be a boolean"),
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

    try {
      const { uuid } = req.user;
      const {
        type,
        message,
        messageValue,
        RateExp,
        Anotherdinner,
        Requiresaction,
      } = req.body;

      const notification = await Notifications.create({
        _id: uuidv4(),
        userId: uuid,
        type,
        message: {
          message,
          value: messageValue || 0,
        },
        RateExp: type === "rateExp" ? RateExp : undefined,
        Anotherdinner: type === "anotherDinner" ? Anotherdinner : undefined,
        Requiresaction: type === "message" ? false : Requiresaction,
      });

      return res.status(201).json({
        success: true,
        message: "Notification created successfully",
        data: notification,
      });
    } catch (error) {
      console.error("Add notification error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error during notification creation",
        data: null,
      });
    }
  }
);

// Get All User Notifications
notisRouter.get("/", async (req, res) => {
  try {
    const { uuid } = req.user;

    const notifications = await Notifications.find({ userId: uuid })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Notifications retrieved successfully",
      data: notifications,
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during notification retrieval",
      data: null,
    });
  }
});

// Update Notification
notisRouter.patch(
  "/update/:id",
  [
    param("id").isUUID().withMessage("Valid notification ID required"),
    body("value").exists().withMessage("Value is required"),
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

    try {
      const { id } = req.params;
      const { uuid } = req.user;
      const { value } = req.body;

      const notification = await Notifications.findOne({
        _id: id,
        userId: uuid,
      });
      if (!notification) {
        return res.status(404).json({
          success: false,
          message: "Notification not found or unauthorized",
          data: null,
        });
      }

      if (!notification.Requiresaction) {
        return res.status(403).json({
          success: false,
          message: "Cannot update notification without Requiresaction",
          data: null,
        });
      }

      // Validate value type based on notification type
      if (notification.type === "message" || notification.type === "rateExp") {
        if (typeof value !== "number") {
          return res.status(400).json({
            success: false,
            message: `Value must be a number for ${notification.type} type`,
            data: null,
          });
        }
      } else if (notification.type === "anotherDinner") {
        if (typeof value !== "boolean") {
          return res.status(400).json({
            success: false,
            message: "Value must be a boolean for anotherDinner type",
            data: null,
          });
        }
      }

      // Update value based on existing type
      if (notification.type === "message") {
        notification.message.value = value;
      } else if (notification.type === "rateExp") {
        notification.RateExp = notification.RateExp || {};
        notification.RateExp.value = value;
      } else if (notification.type === "anotherDinner") {
        notification.Anotherdinner = notification.Anotherdinner || {};
        notification.Anotherdinner.value = value;
      }

      await notification.save();

      return res.status(200).json({
        success: true,
        message: "Notification updated successfully",
        data: notification,
      });
    } catch (error) {
      console.error("Update notification error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error during notification update",
        data: null,
      });
    }
  }
);

module.exports = notisRouter;
