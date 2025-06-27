const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const Profile = require("../models/authModel");
const verifyJWT = require("../middlewares/verifyJWT");
const { body, validationResult } = require("express-validator");
const verifyFirebaseJWT = require("../middlewares/verifyFirebaseJWT");
const querystring = require("querystring");
const axios = require("axios");

const socialSigninRouter = express.Router();

//google signin
socialSigninRouter.get("/google", verifyFirebaseJWT, async (req, res) => {
  try {
    const { email } = req.firebaseUser;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email not found in token",
      });
    }

    const user = await Profile.findOne({ email }).select("-password");

    if (!user || user.deleted || user.deactivated) {
      return res.status(401).json({
        success: false,
        message: "Account not active or does not exist",
      });
    }

    const payload = {
      uuid: user._id,
      email: user.email,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      token,
      data: user,
    });
  } catch (err) {
    console.error("Error during Google social login:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// LinkedIn sign-in: Initiate OAuth flow
socialSigninRouter.get("/linkedin", (req, res) => {
  const linkedInAuthUrl = "https://www.linkedin.com/oauth/v2/authorization";
  const params = {
    response_type: "code",
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    scope: "openid profile email",
    state: uuidv4(), // CSRF protection
  };

  const authUrl = `${linkedInAuthUrl}?${querystring.stringify(params)}`;
  res.redirect(authUrl);
});

// LinkedIn callback: Fetch email and log in user
socialSigninRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code) {
    return res.status(400).json({
      success: false,
      message: error || "Authorization code not provided",
    });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      querystring.stringify({
        grant_type: "authorization_code",
        code,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token } = tokenResponse.data;

    // Fetch user profile using OpenID Connect /userinfo endpoint
    const userResponse = await axios.get(
      "https://api.linkedin.com/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    const { email } = userResponse.data;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email not provided by LinkedIn",
      });
    }

    // Search for existing user by email
    const user = await Profile.findOne({ email }).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No account found with this email. Please register.",
      });
    }

    if (user.deleted || user.deactivated) {
      return res.status(401).json({
        success: false,
        message: "Account not active or does not exist",
      });
    }

    const payload = {
      uuid: user._id,
      email: user.email,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      success: true,
      message: "LinkedIn login successful",
      token,
      data: user,
    });
  } catch (err) {
    console.error("Error during LinkedIn social login:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

//facebook signin
socialSigninRouter.get("/facebook", (req, res) => {
  res.send("facebook");
});

module.exports = socialSigninRouter;
