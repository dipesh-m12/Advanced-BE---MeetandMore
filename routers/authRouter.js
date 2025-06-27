const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const Profile = require("../models/authModel");
const verifyJWT = require("../middlewares/verifyJWT");
const { body, validationResult } = require("express-validator");
const socialSigninRouter = require("./socialSignInRouter");
const redis = require("redis");
const twilio = require("twilio");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();
const formatError = (msg) => ({ success: false, message: msg, data: null });

const authRouter = express.Router();

// Map countries to currencies
const countryToCurrencyMap = {
  IN: "INR",
  US: "USD",
  CA: "CAD",
  GB: "GBP",
  FR: "EUR",
  DE: "EUR",
  IT: "EUR",
  ES: "EUR",
  AU: "AUD",
  SG: "SGD",
  HK: "HKD",
  JP: "JPY",
  KR: "KRW",
  MY: "MYR",
  TH: "THB",
  AE: "AED",
  QA: "QAR",
  SA: "SAR",
  EG: "EGP",
  ZA: "ZAR",
  AR: "ARS",
  MX: "MXN",
  NG: "NGN",
  RU: "RUB",
  TR: "TRY",
  CL: "CLP",
  BR: "BRL",
  PE: "PEN",
  CO: "COP",
  RW: "RWF",
  KE: "KES",
  BD: "BDT",
};

// Safe Redis helper
const safeRedis = async (fn, operationName) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error in ${operationName}:`, err);
    throw err;
  }
};

//Social Signins
authRouter.use("/socialSignIn", socialSigninRouter);

// Register
authRouter.post(
  "/register",
  [
    body("country_code")
      .exists()
      .withMessage("Country code is required")
      .matches(/^\+\d{1,3}$/)
      .withMessage("Invalid country code format"),
    body("phone_number")
      .exists()
      .withMessage("Phone number is required")
      .matches(/^\d{10}$/)
      .withMessage("Phone number must be 10 digits"),
    body("email")
      .exists()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Invalid email format"),
    body("password")
      .exists()
      .withMessage("Password is required")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("name")
      .exists()
      .withMessage("Name is required")
      .isLength({ min: 2 })
      .withMessage("Name must be at least 2 characters"),
    body("dob")
      .exists()
      .withMessage("Date of birth is required")
      .isISO8601()
      .withMessage("Date of birth must be a valid date"),
    body("city").exists().withMessage("City is required"),
    body("university")
      .optional()
      .isString()
      .withMessage("University is required"),
    body("gender")
      .exists()
      .withMessage("Gender is required")
      .isIn(["Male", "Female", "Other"])
      .withMessage("Gender must be Male, Female, or Other"),
    body("country") // Validate country in request body
      .exists()
      .withMessage("Country is required")
      .matches(/^[A-Z]{2}$/)
      .withMessage("Country must be a 2-letter ISO code (e.g., US, CA)"),
    // You can add validations for location, loc_coords, pushtoken, avatar if needed
  ],
  async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const firstError = errors.array()[0];
      return res.status(400).json({
        success: false,
        message: firstError.msg,
      });
    }
    // Your existing registration logic below
    try {
      const {
        country_code,
        phone_number,
        email,
        password,
        name,
        dob,
        city,
        location,
        loc_coords,
        university,
        gender,
        pushtoken,
        avatar,
        country,
      } = req.body;

      // Check for active users with email or phone_number
      const existingUser = await Profile.findOne({
        $or: [
          { email, deleted: false },
          { phone_number, deleted: false },
        ],
      });
      if (existingUser) {
        let conflictField =
          existingUser.email === email ? "email" : "phone number";

        return res.status(409).json({
          token: null,
          success: false,
          message: `User with this ${conflictField} already exists`,
          data: null,
        });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      const uuid = uuidv4();

      // Check for soft-deleted user with the same email
      const softDeletedUser = await Profile.findOne({ email, deleted: true });
      if (softDeletedUser) {
        // Optionally, permanently delete the soft-deleted user to free up the email
        await Profile.deleteOne({ _id: softDeletedUser._id });
      }

      // Determine regionCurrency based on country
      const regionCurrency =
        countryToCurrencyMap[country.toUpperCase()] || "INR";

      const newUser = await Profile.create({
        _id: uuid,
        country_code,
        phone_number,
        email,
        password: hashedPassword,
        name,
        dob,
        city,
        location,
        loc_coords,
        university,
        gender,
        pushtoken,
        avatar,
        region_currency: regionCurrency,
      });

      // Update Redis with pushtoken if provided
      if (pushtoken) {
        await redisClient.set(
          `notifications:${uuid}`,
          pushtoken,
          { EX: 86400 } // 1 day TTL
        );
      }

      // Cache name if updated
      if (name) {
        await safeRedis(
          () => redisClient.setEx(`profile:name:${uuid}`, 86400, name),
          `cache profile:name:${uuid}`
        );
      }

      // Exclude password from the user object before sending response
      const { password: pwd, ...userWithoutPassword } = newUser.toObject();

      const token = jwt.sign({ email, uuid }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });

      return res.status(201).json({
        token,
        success: true,
        message: "Registration successful",
        data: userWithoutPassword,
      });
    } catch (error) {
      console.error(error);
      if (error.code === 11000) {
        const duplicatedField = Object.keys(error.keyValue)[0];
        return res.status(409).json({
          token: null,
          success: false,
          message: `User with this ${duplicatedField} already exists`,
          data: null,
        });
      }

      return res.status(500).json({
        token: null,
        success: false,
        message: "Server error during registration",
        data: null,
      });
    }
  }
);

// Login
authRouter.post(
  "/login",
  [
    body("email")
      .exists()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Invalid email format"),
    body("password")
      .exists()
      .withMessage("Password is required")
      .notEmpty()
      .withMessage("Password cannot be empty"),
    body("pushtoken")
      .optional()
      .isString()
      .notEmpty()
      .withMessage("Push token cannot be empty"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
      });
    }

    try {
      const { email, password, pushtoken } = req.body;
      const user = await Profile.findOne({ email });

      if (!user || user.deleted || user.deactivated) {
        return res.status(401).json({
          token: null,
          success: false,
          message: "Account is deactivated or deleted",
          data: null,
        });
      }
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          token: null,
          success: false,
          message: "Invalid credentials",
          data: null,
        });
      }

      // Update pushtoken in Profile if provided
      if (pushtoken && pushtoken !== user.pushtoken) {
        user.pushtoken = pushtoken;
        await user.save();
      }

      // Update Redis with pushtoken (from request or user)
      if (pushtoken || user.pushtoken) {
        await redisClient.set(
          `notifications:${user._id}`,
          pushtoken || user.pushtoken,
          { EX: 86400 } // 1 day TTL
        );
      }

      const token = jwt.sign(
        { email: user.email, uuid: user._id },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.status(200).json({
        token,
        success: true,
        message: "Login successful",
        data: user,
      });
    } catch (error) {
      console.error("Error during login:", error);
      return res.status(500).json(formatError("Server error during login"));
    }
  }
);

// Auto-login (JWT in header)
authRouter.get("/autologin", verifyJWT, async (req, res) => {
  try {
    const { email, uuid } = req.user;

    const user = await Profile.findOne({ _id: uuid, email }).select(
      "-password"
    );

    if (!user || user.deleted || user.deactivated) {
      return res.status(401).json({
        token: null,
        success: false,
        message: "Account is deactivated or deleted",
        data: null,
      });
    }

    // Update Redis with pushtoken if exists in profile
    if (user.pushtoken) {
      await redisClient.set(
        `notifications:${uuid}`,
        user.pushtoken,
        { EX: 86400 } // 1 day TTL
      );
    }

    return res.status(200).json({
      success: true,
      message: "Auto-login successful",
      data: user,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error during auto-login",
      data: null,
    });
  }
});

// Update Profile
authRouter.put(
  "/update",
  verifyJWT,
  [
    body().custom((value) => {
      if (!value || Object.keys(value).length === 0) {
        throw new Error("Request body cannot be empty");
      }
      return true;
    }),
    body("email").optional().isEmail().withMessage("Invalid email format"),
    body("phone_number")
      .optional()
      .matches(/^\d{10}$/)
      .withMessage("Phone number must be 10 digits"),
    body("dob")
      .optional()
      .isISO8601()
      .withMessage("Date of birth must be a valid date"),
    body("gender")
      .optional()
      .isIn(["Male", "Female", "Other"])
      .withMessage("Invalid gender value"),
    body("pushtoken")
      .optional()
      .isString()
      .notEmpty()
      .withMessage("Push token cannot be empty if provided"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
      });
    }

    try {
      const { uuid, email } = req.user;
      const user = await Profile.findOne({ email });

      if (!user || user.deleted || user.deactivated) {
        return res.status(401).json({
          token: null,
          success: false,
          message: "Account is deactivated or deleted",
          data: null,
        });
      }

      // Prevent accidental update of protected fields
      const protectedFields = [
        "_id",
        "uuid",
        "password",
        "email",
        "hasAvailedFirstTimeDiscount",
      ];
      const updateData = { ...req.body };
      protectedFields.forEach((field) => delete updateData[field]);

      // Update pushtoken in Redis if provided
      if (updateData.pushtoken) {
        await redisClient.set(
          `notifications:${uuid}`,
          updateData.pushtoken,
          { EX: 86400 } // 1 day TTL
        );
      } else if (user.pushtoken && !updateData.pushtoken) {
        // Ensure existing pushtoken is preserved in Redis
        await redisClient.set(
          `notifications:${uuid}`,
          user.pushtoken,
          { EX: 86400 } // 1 day TTL
        );
      }

      const updatedUser = await Profile.findByIdAndUpdate(uuid, updateData, {
        new: true,
      });

      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: "User not found for update",
          data: null,
        });
      }

      // Update Redis with pushtoken if provided
      if (updatedUser.pushtoken) {
        await redisClient.set(
          `notifications:${uuid}`,
          updatedUser.pushtoken,
          { EX: 86400 } // 1 day TTL
        );
      }

      // Cache name if updated
      if (updateData.name) {
        await safeRedis(
          () =>
            redisClient.setEx(`profile:name:${uuid}`, 86400, updateData.name),
          `cache profile:name:${uuid}`
        );
      }
      return res.status(200).json({
        success: true,
        message: "Profile updated successfully",
        data: updatedUser,
      });
    } catch (error) {
      console.error("PROFILE UPDATE ERROR:", error.message);
      return res
        .status(500)
        .json(formatError("Server error during profile update"));
    }
  }
);

//Toggle Deactivation status
authRouter.patch("/deactivate", verifyJWT, async (req, res) => {
  try {
    const { uuid } = req.user;

    const user = await Profile.findById(uuid);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.deactivated = !user.deactivated;
    await user.save();

    return res.status(200).json({
      success: true,
      message: `Account ${
        user.deactivated ? "deactivated" : "reactivated"
      } successfully`,
      data: { deactivated: user.deactivated },
    });
  } catch (error) {
    console.error("DEACTIVATE ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error during deactivation toggle",
    });
  }
});

//Delete account
authRouter.delete("/delete", verifyJWT, async (req, res) => {
  try {
    const { uuid } = req.user;

    const user = await Profile.findById(uuid);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.deleted) {
      return res.status(400).json({
        success: false,
        message: "Account is already deleted",
      });
    }

    user.deleted = true;
    await user.save();

    // Remove user from Redis keys
    const multi = redisClient.multi();
    multi.sRem("onlineUsers", uuid);
    multi.del(`sockets:${uuid}`);
    const userChannels = await safeRedis(
      () => redisClient.sMembers(`userChannels:${uuid}`),
      `fetch userChannels:${uuid}`
    );
    if (userChannels && userChannels.length > 0) {
      userChannels.forEach((channelId) => {
        multi.sRem(`channelReceivers:${channelId}`, uuid);
        multi.expire(`channelReceivers:${channelId}`, 43200); // Refresh TTL
      });
    }
    multi.del(`userChannels:${uuid}`);
    multi.del(`notifications:${uuid}`);
    multi.del(`profile:name:${uuid}`);
    // Execute all Redis operations
    await safeRedis(() => multi.exec(), "cleanup Redis keys for deleted user");

    return res.status(200).json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    console.error("DELETE ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error during account deletion",
    });
  }
});

// Change Password
authRouter.post(
  "/change-password",
  verifyJWT,
  [
    body("oldPassword")
      .exists()
      .withMessage("Old password is required")
      .notEmpty()
      .withMessage("Old password cannot be empty"),
    body("newPassword")
      .exists()
      .withMessage("New password is required")
      .isLength({ min: 6 })
      .withMessage("New password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
      });
    }

    try {
      const { oldPassword, newPassword } = req.body;
      const { uuid } = req.user;

      // Find active user by uuid
      const user = await Profile.findById(uuid).select("+password"); // Include password field

      if (!user || user.deleted || user.deactivated) {
        return res.status(404).json({
          success: false,
          message: "User not found or account is deactivated/deleted",
          data: null,
        });
      }

      // Compare oldPassword with stored password
      const isMatch = await bcrypt.compare(oldPassword, user.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Incorrect old password",
          data: null,
        });
      }

      // Hash newPassword
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      // Update password
      user.password = hashedPassword;
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Password changed successfully",
        data: null,
      });
    } catch (error) {
      console.error("PASSWORD CHANGE ERROR:", error.message, error.stack);
      return res.status(500).json({
        success: false,
        message: "Server error during password change",
        error: error.message,
      });
    }
  }
);

// Change phone number - Generate OTP
authRouter.post(
  "/phoneNumber",
  verifyJWT,
  [
    body("phoneNumber")
      .matches(/^\d{10}$/)
      .withMessage("Phone number must be 10 digits"),
    body("countryCode")
      .matches(/^\+\d{1,3}$/)
      .withMessage("Valid country code required (e.g., +1, +91)"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(formatError(errors.array()[0].msg));
    }

    try {
      const { phoneNumber, countryCode } = req.body;
      const { uuid } = req.user;
      const fullPhone = `${countryCode}${phoneNumber}`; // For Twilio
      const code = generateOTP();
      const id = uuidv4();

      // Store OTP data
      await redisClient.setEx(
        `updatePhone:${id}`,
        300,
        JSON.stringify({ code, phoneNumber, countryCode, uuid, attempts: 0 })
      );

      // Send OTP
      await twilioClient.messages.create({
        body: `Your verification code is ${code}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: fullPhone,
      });

      res.status(200).json({
        success: true,
        message: "Verification code sent successfully",
        data: { id },
      });
    } catch (err) {
      console.error("Phone Number OTP Generation Error:", err.stack);
      res.status(500).json(formatError("Failed to generate verification code"));
    }
  }
);

// Verify phone number and update
authRouter.patch(
  "/verifyPhone",
  verifyJWT,
  [
    body("id").isUUID().withMessage("Valid verification ID required"),
    body("code")
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(formatError(errors.array()[0].msg));
    }

    const { id, code } = req.body;
    const { uuid } = req.user;

    try {
      const stored = await redisClient.get(`updatePhone:${id}`);
      if (!stored) {
        return res
          .status(400)
          .json(formatError("Verification expired or not found"));
      }

      const {
        code: savedCode,
        phoneNumber,
        countryCode,
        uuid: storedUuid,
        attempts,
      } = JSON.parse(stored);

      if (storedUuid !== uuid) {
        return res
          .status(403)
          .json(formatError("Unauthorized to verify this code"));
      }

      const newAttempts = attempts + 1;
      if (newAttempts > 3) {
        await redisClient.del(`updatePhone:${id}`);
        return res
          .status(400)
          .json(formatError("Maximum verification attempts exceeded"));
      }

      await redisClient.setEx(
        `updatePhone:${id}`,
        300,
        JSON.stringify({
          code: savedCode,
          phoneNumber,
          countryCode,
          uuid,
          attempts: newAttempts,
        })
      );

      if (savedCode !== code) {
        return res.status(400).json(formatError("Invalid verification code"));
      }

      // Update phone number and country code in Profile
      const user = await Profile.findById(uuid);
      if (!user || user.deleted || user.deactivated) {
        return res
          .status(403)
          .json(formatError("Account is deactivated or deleted"));
      }

      user.phone_number = phoneNumber;
      user.country_code = countryCode;
      await user.save();

      await redisClient.del(`updatePhone:${id}`);

      res.status(200).json({
        success: true,
        message: "Phone number updated successfully",
        data: { phone: `${countryCode}${phoneNumber}` },
      });
    } catch (err) {
      console.error("Phone Verification Error:", err.stack);
      res.status(500).json(formatError("Failed to verify code"));
    }
  }
);

module.exports = authRouter;
