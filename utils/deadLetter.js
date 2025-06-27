const { Queue } = require("bullmq");
const Redis = require("ioredis");

// Configure Redis client
const redisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
  }
);

// Log Redis connection errors
redisClient.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

const sendToDeadLetter = async (jobName, data) => {
  const deadQueue = new Queue("dead-letter", { connection: redisClient });
  await deadQueue.add(jobName, data);
};

module.exports = { sendToDeadLetter };
