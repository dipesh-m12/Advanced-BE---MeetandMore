const Redis = require("redis");

const redisClient = Redis.createClient({
  url: "redis://localhost:6379", // Update with your Redis host/port
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 500, 5000), // Retry every 500ms, max 5s
    connectTimeout: 10000, // 10s timeout
  },
});

redisClient.on("error", (err) => console.error("Redis Error:", err));

module.exports = redisClient;
