const jwt = require("jsonwebtoken");

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      token: null,
      success: false,
      message: "Missing or malformed Authorization header",
      data: null,
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // console.log("DECODED JWT PAYLOAD:", decoded);

    // Inject decoded contents into request body
    req.user = {
      email: decoded.email,
      uuid: decoded.uuid,
    };

    next(); // pass control to next middleware/route
  } catch (err) {
    console.error("JWT VERIFY ERROR:", err.message);
    return res.status(401).json({
      token: null,
      success: false,
      message: "Invalid or expired token",
      data: null,
    });
  }
};

module.exports = verifyJWT;
