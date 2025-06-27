const express = require("express");
const { v4: uuidv4 } = require("uuid");
const redis = require("redis");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");
const twilio = require("twilio");

const verifyRouter = express.Router();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();
const formatError = (msg) => ({ success: false, message: msg, data: null });

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError("Too many OTP requests, please try again later"),
});

verifyRouter.post(
  "/generate",
  [
    body("phone").isMobilePhone().withMessage("Valid phone number required"),
    otpLimiter,
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json(formatError(errors.array()[0].msg));

    try {
      const { phone } = req.body;
      const code = generateOTP();
      const id = uuidv4();

      await redisClient.setEx(
        `verification:${id}`,
        300,
        JSON.stringify({ code, phone, attempts: 0 })
      );

      await twilioClient.messages.create({
        body: `Your verification code is ${code}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });

      res.status(200).json({
        success: true,
        message: "Verification code sent successfully",
        data: { id },
      });
    } catch (err) {
      console.error("OTP Generation Error:", err.stack);
      res.status(500).json(formatError("Failed to generate verification code"));
    }
  }
);

verifyRouter.post(
  "/:id",
  [
    body("code")
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json(formatError(errors.array()[0].msg));

    const { id } = req.params;
    const { code } = req.body;

    try {
      const stored = await redisClient.get(`verification:${id}`);
      if (!stored)
        return res
          .status(400)
          .json(formatError("Verification expired or not found"));

      const { code: savedCode, phone, attempts } = JSON.parse(stored);

      const newAttempts = attempts + 1;
      if (newAttempts > 3) {
        await redisClient.del(`verification:${id}`);
        return res
          .status(400)
          .json(formatError("Maximum verification attempts exceeded"));
      }

      await redisClient.setEx(
        `verification:${id}`,
        300,
        JSON.stringify({ code: savedCode, phone, attempts: newAttempts })
      );

      if (savedCode !== code)
        return res.status(400).json(formatError("Invalid verification code"));

      await redisClient.del(`verification:${id}`);

      res.status(200).json({
        success: true,
        message: "Verification successful",
        data: { phone },
      });
    } catch (err) {
      console.error("OTP Verification Error:", err.stack);
      res.status(500).json(formatError("Failed to verify code"));
    }
  }
);

module.exports = verifyRouter;
