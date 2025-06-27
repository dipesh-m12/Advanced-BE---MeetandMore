const express = require("express");
const { body, validationResult, param } = require("express-validator");
const verifyJWT = require("../middlewares/verifyJWT");
const Referral = require("../models/ReferralCodeModel");
const Reward = require("../models/RewardModel"); // Import new Reward model
const referralRouter = express.Router();
const { v4: uuidv4 } = require("uuid");
const Profile = require("../models/authModel");
const { sendMessageToKafka } = require("../utils/kafka");
const currencies = require("../utils/data");
// Helper function to generate a unique referral code
const generateReferralCode = async (name) => {
  const prefix = name.trim().slice(0, 4).toUpperCase();
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    const code = `${prefix}${randomNumber}`;
    const existingReferral = await Referral.findOne({ code });
    if (!existingReferral) return code;
    attempts++;
  }
  throw new Error(
    "Unable to generate a unique referral code after maximum attempts"
  );
};

// GET /api/referrals/my-coupon
referralRouter.get("/my-coupon", verifyJWT, async (req, res) => {
  try {
    const userId = req.user.uuid;
    const referral = await Referral.findOne({
      userId,
      type: "standard",
      status: "active",
    });
    if (!referral)
      return res.status(404).json({
        success: false,
        message: "No active coupon code found",
        data: null,
      });

    return res.status(200).json({
      success: true,
      message: "Coupon code fetched successfully",
      data: referral,
    });
  } catch (err) {
    console.error("Error fetching coupon code:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch coupon code",
      data: null,
    });
  }
});

// POST /api/referrals/generate-special
referralRouter.post(
  "/generate-special",
  [
    body("name").notEmpty().withMessage("Name is required"),
    body("type")
      .isIn(["influencer", "special"])
      .withMessage("Type must be influencer or special"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { name, type } = req.body;
    try {
      const code = await generateReferralCode(name);
      const referral = new Referral({
        _id: uuidv4(),
        code,
        type,
        status: "active",
        usageCount: 0,
      });
      await referral.save();
      return res.status(201).json({
        success: true,
        message: "Referral code generated successfully",
        data: referral,
      });
    } catch (err) {
      console.error("Error generating referral:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to generate referral code",
        data: null,
      });
    }
  }
);

// POST /api/referrals/generate
referralRouter.post(
  "/generate",
  verifyJWT,
  [
    body("name").notEmpty().withMessage("Name is required"),
    body("type").isIn(["standard"]).withMessage("Type must be standard"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { name, type } = req.body;
    const userId = req.user.uuid;
    try {
      if (type !== "standard") {
        delete req.body.userId;
      } else {
        const existingReferral = await Referral.findOne({ userId });
        if (existingReferral)
          return res.status(400).json({
            success: false,
            message: "User already has a referral code",
            data: null,
          });
      }

      const code = await generateReferralCode(name);
      const referral = new Referral({
        _id: uuidv4(),
        userId: type === "standard" ? userId : undefined,
        code,
        type,
        status: "active",
        usageCount: 0,
      });
      await referral.save();
      return res.status(201).json({
        success: true,
        message: "Referral code generated successfully",
        data: referral,
      });
    } catch (err) {
      console.error("Error generating referral:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to generate referral code",
        data: null,
      });
    }
  }
);

// GET /api/referrals/check/:couponCode
referralRouter.get(
  "/check/:couponCode",
  verifyJWT,
  [param("couponCode").notEmpty().withMessage("Coupon code is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const userId = req.user.uuid;
    const { couponCode } = req.params;
    try {
      const referral = await Referral.findOne({
        code: couponCode,
        status: "active",
      });
      if (!referral)
        return res.status(404).json({
          success: false,
          message: "Referral code not found or inactive",
          data: null,
        });
      if (referral.userId && referral.userId === userId)
        return res.status(400).json({
          success: false,
          message: "Cannot use your own referral code",
          data: null,
        });
      if (referral.type === "special" && referral.usageCount >= 1)
        return res.status(400).json({
          success: false,
          message: "Special code has already been used",
          data: null,
        });

      return res.status(200).json({
        success: true,
        message: "Referral code is active",
        data: referral,
      });
    } catch (err) {
      console.error("Error checking referral code:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to check referral code",
        data: null,
      });
    }
  }
);

// POST /api/referrals/toggle-status/:couponCode
referralRouter.post(
  "/toggle-status/:couponCode",
  verifyJWT,
  [param("couponCode").notEmpty().withMessage("Coupon code is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const { couponCode } = req.params;
    const userId = req.user.uuid;
    try {
      const referral = await Referral.findOne({ code: couponCode });
      if (!referral)
        return res.status(404).json({
          success: false,
          message: "Referral code not found",
          data: null,
        });

      referral.status = referral.status === "active" ? "inactive" : "active";
      await referral.save();
      return res.status(200).json({
        success: true,
        message: `Referral code status toggled to ${referral.status}`,
        data: referral,
      });
    } catch (err) {
      console.error("Error toggling referral status:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to toggle referral status",
        data: null,
      });
    }
  }
);

// POST /api/referrals/use/:couponCode
referralRouter.post(
  "/use/:couponCode",
  verifyJWT,
  [param("couponCode").notEmpty().withMessage("Coupon code is required")],
  async (req, res) => {
    const { couponCode } = req.params;

    try {
      const referral = await Referral.findOne({
        code: couponCode,
        status: "active",
      });
      if (!referral)
        return res.status(404).json({
          success: false,
          message: "Referral code not found or inactive",
          data: null,
        });

      if (referral.type === "special" && referral.usageCount >= 1)
        return res.status(400).json({
          success: false,
          message: "Special code has already been used",
          data: null,
        });

      referral.usageCount += 1;
      await referral.save();

      let ownerReward = 0;
      let ownerCurrency = null;

      // Check if the condition for awarding the owner reward is met
      if (
        referral.type === "standard" &&
        referral.usageCount % referral.rewardAfterUsages === 0
      ) {
        // Fetch the owner profile only if there's a userId associated with the referral
        if (referral.userId) {
          const owner = await Profile.findOne({ _id: referral.userId })
            .select(
              "phone_number name email country_code gender city location region_currency"
            )
            .lean();

          if (owner) {
            // Fetch rewards from Reward model
            const reward = await Reward.findOne({
              referralType: referral.type,
            });
            if (!reward)
              return res.status(500).json({
                success: false,
                message: "Reward configuration not found",
                data: null,
              });

            // Award the owner the reward in their region's currency
            ownerCurrency = owner.region_currency || "INR";
            ownerReward = reward[ownerCurrency]?.ownerReward || 0;

            // Send email notification to the owner
            await sendMessageToKafka("bulk-email", {
              to: process.env.EMAIL_USER,
              subject: "🎉 Referral Reward Earned - Meet and More",
              templateName: "owner-reward",
              data: {
                name: owner.name || "User",
                email: owner.email || "N/A",
                phoneNumber: owner.phone_number || "N/A",
                countryCode: owner.country_code || "N/A",
                gender: owner.gender || "N/A",
                city: owner.city || "N/A",
                location: owner.location || "N/A",
                reward: ownerReward,
                usageCount: referral.usageCount,
                code: referral.code,
                currency: ownerCurrency,
              },
            });
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: "Referral code applied successfully",
        data: {
          ownerReward,
          ownerCurrency,
        },
      });
    } catch (err) {
      console.error("Error using referral code:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to apply referral code",
        data: null,
      });
    }
  }
);

module.exports = referralRouter;
