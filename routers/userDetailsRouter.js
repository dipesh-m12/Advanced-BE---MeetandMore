const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyJWT = require("../middlewares/verifyJWT");
const UserDetails = require("../models/userDetailsModel");

const userDetailsRouter = express.Router();

userDetailsRouter.post(
  "/",
  verifyJWT,
  [
    // Updated validation to make WorkingIndustry required, others optional
    body("WorkingIndustry")
      .exists()
      .withMessage("WorkingIndustry is required")
      .isString(),
    body("PartyPersonality").optional().isString(),
    body("Guide").optional().isString(),
    body("Jam").optional().isString(),
    body("LifeSummarizer").optional().isString(),
    body("Icebreaker").optional().isString(),
    body("IdealDinner").optional().isString(),
    body("Extrovert").optional().isNumeric(),
    body("DeepConnections").optional().isNumeric(),
    body("Dark").optional().isNumeric(),
    body("Doer").optional().isNumeric(),
    body("EasilyOffended").optional().isNumeric(),
    body("Strongly").optional().isNumeric(),
    body("RelationshipStatus").optional().isString(),
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
      const userId = req.user.uuid;

      const existing = await UserDetails.findOne({ userId });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: "User details already exist. Cannot create twice.",
        });
      }

      const newDetails = new UserDetails({
        _id: uuidv4(),
        userId,
        ...req.body,
      });

      await newDetails.save();

      res.status(201).json({
        success: true,
        message: "User details created successfully",
        data: newDetails,
      });
    } catch (error) {
      console.error("Error creating user details:", error);
      res.status(500).json({
        success: false,
        message: "Server error while creating user details",
      });
    }
  }
);

userDetailsRouter.get("/", verifyJWT, async (req, res) => {
  try {
    const userId = req.user.uuid;

    const details = await UserDetails.findOne({ userId });

    if (!details) {
      return res.status(404).json({
        success: false,
        message: "User details not found",
        data: null,
      });
    }

    res.json({
      success: true,
      message: "User details fetched successfully",
      data: details,
    });
  } catch (error) {
    console.error("Error fetching user details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching user details",
    });
  }
});

// Added PUT API to update user details
userDetailsRouter.put(
  "/",
  verifyJWT,
  [
    // Validation for update: WorkingIndustry required, others optional
    body("WorkingIndustry")
      .exists()
      .withMessage("WorkingIndustry is required")
      .isString(),
    body("PartyPersonality").optional().isString(),
    body("Guide").optional().isString(),
    body("Jam").optional().isString(),
    body("LifeSummarizer").optional().isString(),
    body("Icebreaker").optional().isString(),
    body("IdealDinner").optional().isString(),
    body("Extrovert").optional().isNumeric(),
    body("DeepConnections").optional().isNumeric(),
    body("Dark").optional().isNumeric(),
    body("Doer").optional().isNumeric(),
    body("EasilyOffended").optional().isNumeric(),
    body("Strongly").optional().isNumeric(),
    body("RelationshipStatus").optional().isString(),
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
      const userId = req.user.uuid;

      const existing = await UserDetails.findOne({ userId });
      if (!existing) {
        return res.status(404).json({
          success: false,
          message:
            "User details not found. Cannot update non-existent details.",
        });
      }

      // Update only provided fields
      const updatedDetails = await UserDetails.findOneAndUpdate(
        { userId },
        { $set: req.body },
        { new: true, runValidators: true }
      );

      res.json({
        success: true,
        message: "User details updated successfully",
        data: updatedDetails,
      });
    } catch (error) {
      console.error("Error updating user details:", error);
      res.status(500).json({
        success: false,
        message: "Server error while updating user details",
      });
    }
  }
);

module.exports = userDetailsRouter;
