const jwt = require("jsonwebtoken");

// New admin middleware to verify hardcoded admin code
const verifyAdmin = (req, res, next) => {
  const adminCode = req.headers["x-admin-code"]; // Check for x-admin-code header

  // Hardcoded admin code verification
  if (!adminCode || adminCode !== "190237") {
    return res.status(403).json({
      success: false,
      message: "Invalid or missing admin code",
      data: null,
    });
  }

  next(); // Proceed if admin code is correct
};

// Export both middlewares
module.exports = { verifyAdmin };
