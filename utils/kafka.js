const Redis = require("ioredis");
const { Queue } = require("bullmq");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
  }
);

bullRedisClient.on("error", (err) => console.error("BullMQ Redis Error:", err));

const queues = new Map();
const QUEUE_REGISTRY_KEY = "bullmq:active_queues";

const initKafka = async () => {
  try {
    await bullRedisClient.ping();
    // Load existing queues from Redis
    const existingQueues = await bullRedisClient.smembers(QUEUE_REGISTRY_KEY);
    for (const topic of existingQueues) {
      if (!queues.has(topic)) {
        const queue = new Queue(topic, {
          connection: bullRedisClient,
          defaultJobOptions: {
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: "exponential", delay: 1000 },
          },
        });
        queues.set(topic, queue);
      }
    }
    return Promise.resolve();
  } catch (err) {
    console.error("Kafka interface connection failed:", err);
    throw err;
  }
};

const sendMessageToKafka = async (topic, message) => {
  try {
    let queue = queues.get(topic);
    if (!queue) {
      queue = new Queue(topic, {
        connection: bullRedisClient,
        defaultJobOptions: {
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
        },
      });
      queues.set(topic, queue);

      // Register queue in Redis
      await bullRedisClient.sadd(QUEUE_REGISTRY_KEY, topic);
    }

    await queue.add("job", message);
  } catch (error) {
    console.error(`⚠️ Failed to queue message to ${topic}:`, error.message);
  }
};

module.exports = {
  initKafka,
  sendMessageToKafka,
};
