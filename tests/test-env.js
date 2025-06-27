// test-env.js
const path = require("path");
const dotenv = require("dotenv");

// Log the current working directory
console.log("Current Working Directory:", process.cwd());

// Try loading .env from the root
const result = dotenv.config({ path: path.resolve("../.env") });

if (result.error) {
  console.error("Error loading .env:", result.error.message);
} else {
  console.log("Loaded config:", result.parsed);

  // Print environment variables
  console.log("KAFKA_BROKER:", process.env.KAFKA_BROKER);
  console.log("RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID);
  console.log("MONGO_URI:", process.env.MONGO_URI);
  console.log("REDIS_URL:", process.env.REDIS_URL);
}
