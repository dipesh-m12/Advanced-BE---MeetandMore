const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");

const Feedback = require("../models/feedbackModel");
const verifyJWT = require("../middlewares/verifyJWT");

const feedbackRouter = express.Router();

// Add a feedback
feedbackRouter.post(
  "/add",
  verifyJWT,
  [
    body("message").notEmpty().withMessage("Message is required"),
    body("fromReportIssuePage")
      .optional()
      .isBoolean()
      .withMessage("fromReportIssuePage must be a boolean"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg, // Return first validation error
      });
    }

    try {
      const { message, fromReportIssuePage } = req.body;
      const uuid = uuidv4();

      const feedback = await Feedback.create({
        _id: uuid,
        from: req.user.uuid,
        message,
        fromReportIssuePage: !!fromReportIssuePage,
      });

      return res.status(201).json({
        success: true,
        message: "Feedback submitted successfully",
        data: feedback,
      });
    } catch (err) {
      console.error("Error adding feedback:", err);
      return res.status(500).json({
        success: false,
        message: "Server error while adding feedback",
        data: null,
      });
    }
  }
);

// Get all feedback of a user
feedbackRouter.get("/", verifyJWT, async (req, res) => {
  try {
    const feedbacks = await Feedback.find({ from: req.user.uuid }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      message: "Feedbacks fetched successfully",
      data: feedbacks,
    });
  } catch (err) {
    console.error("Error fetching feedback:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching feedback",
      data: null,
    });
  }
});

// Update status of a feedback (Admin or support usage)
feedbackRouter.put(
  "/:id",
  verifyJWT,
  [
    body("status")
      .exists()
      .withMessage("Status is required")
      .isIn(["pending", "in_progress", "resolved"])
      .withMessage("Invalid status value"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg, // Return first validation error
      });
    }

    try {
      const { id } = req.params;
      const { status } = req.body;
      const { uuid } = req.user;

      // Find the feedback and verify ownership
      const feedback = await Feedback.findById(id);

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: "Feedback not found",
          data: null,
        });
      }

      if (feedback.from !== uuid) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized: You are not the owner of this feedback",
          data: null,
        });
      }

      // Update status
      feedback.status = status;
      await feedback.save();

      return res.status(200).json({
        success: true,
        message: "Feedback status updated",
        data: feedback,
      });
    } catch (err) {
      console.error("Error updating feedback:", err);
      return res.status(500).json({
        success: false,
        message: "Server error while updating feedback",
        data: null,
      });
    }
  }
);

module.exports = feedbackRouter;
