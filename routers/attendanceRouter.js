const express = require("express");
const mongoose = require("mongoose");
const { body, param, validationResult } = require("express-validator");
const QRCode = require("qrcode");
const Waitlist = require("../models/waitlistModel");
const { EventDate } = require("../models/DateModel");
const { VenueCity } = require("../models/eventModel");
const { DateTime } = require("luxon");
const verifyJWT = require("../middlewares/verifyJWT");
const Profile = require("../models/authModel");

const router = express.Router();

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

// GET /api/attendance/:dateId - Get user's attendance status
router.get(
  "/:dateId",
  verifyJWT,
  [param("dateId").notEmpty().withMessage("Date ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { dateId } = req.params;
      const userId = req.user.uuid; // Use uuid from verifyJWT

      const waitlist = await Waitlist.findOne({ userId, dateId }).lean();
      if (!waitlist) {
        return res.status(404).json({
          success: false,
          message: "Waitlist entry not found",
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Attendance status fetched successfully",
        data: {
          attendance: waitlist.attendance || false,
          status: waitlist.status,
        },
      });
    } catch (err) {
      console.error("Error checking attendance:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to check attendance",
        data: null,
      });
    }
  }
);

// POST /api/attendance/generate-qr - Generate QR code
router.post(
  "/generate-qr",
  verifyJWT,
  [body("waitlistId").notEmpty().withMessage("Waitlist ID is required")],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { waitlistId } = req.body;
      const userId = req.user.uuid; // Use uuid from verifyJWT

      const waitlist = await Waitlist.findById(waitlistId);
      if (
        !waitlist ||
        waitlist.userId !== userId ||
        waitlist.status !== "confirmed"
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid or unconfirmed waitlist entry",
          data: null,
        });
      }

      const eventDate = await EventDate.findById(waitlist.dateId).lean();
      if (!eventDate) {
        return res.status(404).json({
          success: false,
          message: "Event date not found",
          data: null,
        });
      }

      const city = await VenueCity.findById(eventDate.city)
        .select("timezone")
        .lean();
      if (!city) {
        return res.status(404).json({
          success: false,
          message: "City not found",
          data: null,
        });
      }

      const now = DateTime.now().setZone(city.timezone);
      const eventLocal = DateTime.fromJSDate(eventDate.date, {
        zone: "utc",
      }).setZone(city.timezone);
      const eventDayStart = eventLocal.startOf("day");
      const eventDayEnd = eventLocal.endOf("day");
      if (now < eventDayStart || now > eventDayEnd) {
        // now < eventDayStart ||
        return res.status(400).json({
          success: false,
          message: "QR code can only be generated on the event day",
          data: null,
        });
      }

      const siteUrl =
        process.env.NODE_ENV === "production"
          ? `https://meetandmore-media.s3.eu-north-1.amazonaws.com/barcode.html?waitlistId=${waitlistId}`
          : //   `https://meetandmore-media.s3.eu-north-1.amazonaws.com/barcode.html?waitlistId=${waitlistId}`
            `https://meetandmore-media.s3.eu-north-1.amazonaws.com/barcode.html?waitlistId=${waitlistId}`;
      const qrCodeUrl = await QRCode.toDataURL(siteUrl);

      return res.status(200).json({
        success: true,
        message: "QR code generated successfully",
        data: { qrCodeUrl },
      });
    } catch (err) {
      console.error("Error generating QR code:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to generate QR code",
        data: null,
      });
    }
  }
);

// POST /api/attendance/mark-by-qr - Mark attendance
router.post(
  "/mark-by-qr",
  [
    body("waitlistId").notEmpty().withMessage("Waitlist ID is required"),
    body("latitude")
      .notEmpty()
      .isFloat()
      .withMessage("Latitude must be a number"),
    body("longitude")
      .notEmpty()
      .isFloat()
      .withMessage("Longitude must be a number"),
  ],
  handleValidationErrors,
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const { waitlistId, latitude, longitude } = req.body;

        const waitlist = await Waitlist.findById(waitlistId).session(session);
        if (!waitlist || waitlist.status !== "confirmed") {
          return res.status(400).json({
            success: false,
            message: "Invalid or unconfirmed waitlist entry",
            data: null,
          });
        }

        if (waitlist.attendance) {
          return res.status(400).json({
            success: false,
            message: "Attendance already marked for this user",
            data: null,
          });
        }

        const eventDate = await EventDate.findById(waitlist.dateId).lean({
          session,
        });
        if (!eventDate) {
          return res.status(404).json({
            success: false,
            message: "Event date not found",
            data: null,
          });
        }

        const city = await VenueCity.findById(eventDate.city)
          .select("timezone")
          .lean({ session });
        if (!city) {
          return res.status(404).json({
            success: false,
            message: "City not found",
            data: null,
          });
        }

        const now = DateTime.now().setZone(city.timezone);
        const eventLocal = DateTime.fromJSDate(eventDate.date, {
          zone: "utc",
        }).setZone(city.timezone);
        const eventDayStart = eventLocal.startOf("day");
        const eventDayEnd = eventLocal.endOf("day");
        if (now < eventDayStart || now > eventDayEnd) {
          return res.status(400).json({
            success: false,
            message: "Attendance can only be marked on the event day",
            data: null,
          });
        }

        waitlist.attendance = true;
        // Save geolocation if provided
        if (latitude !== undefined && longitude !== undefined) {
          waitlist.latitude = latitude;
          waitlist.longitude = longitude;
        }
        await waitlist.save({ session });

        return res.status(200).json({
          success: true,
          message: "Attendance marked successfully",
          data: null,
        });
      });
    } catch (err) {
      console.error("Error marking attendance:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to mark attendance",
        data: null,
      });
    } finally {
      session.endSession();
    }
  }
);

// New GET route to generate QR code and return HTML with image
router.get("/generate-qr/:waitlistId", async (req, res) => {
  try {
    const { waitlistId } = req.params;

    // Validate waitlistId
    if (!waitlistId) {
      return res.status(400).json({
        success: false,
        message: "Waitlist ID is required",
        data: null,
      });
    }

    // Find the waitlist entry
    const waitlist = await Waitlist.findById(waitlistId);
    if (!waitlist || waitlist.status !== "confirmed") {
      return res.status(400).json({
        success: false,
        message: "Invalid or unconfirmed waitlist entry",
        data: null,
      });
    }

    // Find the event date
    const eventDate = await EventDate.findById(waitlist.dateId).lean();
    if (!eventDate) {
      return res.status(404).json({
        success: false,
        message: "Event date not found",
        data: null,
      });
    }

    // Find the city and timezone
    const city = await VenueCity.findById(eventDate.city)
      .select("city_name timezone")
      .lean();
    if (!city) {
      return res.status(404).json({
        success: false,
        message: "City not found",
        data: null,
      });
    }

    // Check if today is the event day
    const now = DateTime.now().setZone(city.timezone);
    const eventLocal = DateTime.fromJSDate(eventDate.date, {
      zone: "utc",
    }).setZone(city.timezone);
    const eventDayStart = eventLocal.startOf("day");
    const eventDayEnd = eventLocal.endOf("day");
    if (now < eventDayStart || now > eventDayEnd) {
      return res.status(400).json({
        success: false,
        message: "QR code can only be generated on the event day",
        data: null,
      });
    }

    // Find the user to get their name
    const user = await Profile.findById(waitlist.userId, "name").lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
        data: null,
      });
    }

    // Generate the QR code
    const siteUrl =
      process.env.NODE_ENV === "production"
        ? `https://meetandmore-media.s3.eu-north-1.amazonaws.com/barcode.html?waitlistId=${waitlistId}`
        : `https://meetandmore-media.s3.eu-north-1.amazonaws.com/barcode.html?waitlistId=${waitlistId}`;
    const qrCodeUrl = await QRCode.toDataURL(siteUrl);

    // Prepare HTML response with centered, responsive QR code image
    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Your Attendance QR Code - Meet and More</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background-color: #f4f4f4;
              margin: 0;
              padding: 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              text-align: center;
            }
            .container {
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
              max-width: 600px;
              width: 100%;
            }
            h2 {
              color: #333;
              margin-bottom: 20px;
            }
            p {
              color: #555;
              font-size: 16px;
              margin-bottom: 20px;
            }
            .qr-code {
              width: 100%;
              max-width: 300px; /* Default size for larger screens */
              height: auto;
              border: 1px solid #ddd;
              padding: 10px;
              background-color: white;
              display: block;
              margin: 0 auto;
            }
            /* Responsive sizing for smaller screens */
            @media (max-width: 600px) {
              .qr-code {
                max-width: 200px; /* Smaller size for mobile screens */
              }
            }
            @media (max-width: 400px) {
              .qr-code {
                max-width: 150px; /* Even smaller for very small screens */
              }
            }
            .footer {
              margin-top: 20px;
              font-size: 12px;
              color: #666;
            }
            .footer a {
              color: #007bff;
              text-decoration: none;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>📍 Your Attendance QR Code</h2>
            <p>Dear ${user.name || "User"},</p>
            <p>Here is your QR code for the event in <strong>${
              city.city_name || "Unknown City"
            }</strong> on <strong>${
      eventLocal.toLocaleString(DateTime.DATETIME_MED) || "Unknown Date"
    }</strong>.</p>
            <p>Scan this QR code at the venue to mark your attendance.</p>
            <img src="${qrCodeUrl}" alt="Attendance QR Code" class="qr-code">
            <div class="footer">
              <p>Need help? Contact us at <a href="mailto:support@meetandmore.com">support@meetandmore.com</a></p>
              <p>© 2025 Meet and More. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `;

    // Send the HTML response
    res.send(html);
  } catch (err) {
    console.error("Error generating QR code and rendering page:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate QR code and render page",
      data: null,
    });
  }
});

module.exports = router;
