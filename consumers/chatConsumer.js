const Redis = require("ioredis");
const { Worker, Queue } = require("bullmq");
const { Chat } = require("../models/chatModels");
const { v4: uuidv4 } = require("uuid");
const redis = require("redis");

// Redis client (for keys like chat:delete:id)
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

// BullMQ Redis connection
const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null, // Required by BullMQ
  }
);

const QUEUE_NAME = "chat-messages";
const BATCH_SIZE = 200;
const BATCH_INTERVAL = 5000; // 5 seconds
const CONCURRENCY = 1;

const messageBuffer = [];

// Batch processor
const processBatch = async (messages) => {
  if (!messages.length) return;

  const chatIds = messages.map(({ chat }) => chat._id);
  const pendingDeletes = await redisClient.mGet(
    chatIds.map((id) => `chat:delete:${id}`)
  );
  const pendingReactions = await redisClient.mGet(
    chatIds.map((id) => `chat:reaction:${id}`)
  );

  const chatDocuments = messages.map(({ chat }, index) => {
    const doc = {
      _id: chat._id,
      channelId: chat.channelId,
      type: chat.type,
      from: chat.from,
      message: chat.message,
      media: chat.media,
      mediaType: chat.mediaType,
      replyTo: chat.replyTo,
      time: new Date(chat.time),
      reactedWith: [],
      isDeleted: false,
    };

    if (pendingDeletes[index] === "true") {
      doc.isDeleted = true;
    }

    if (pendingReactions[index]) {
      const reaction = JSON.parse(pendingReactions[index]);
      doc.reactedWith.push({
        id: reaction.userId,
        reactedWith: reaction.reaction,
      });
    }

    return doc;
  });

  try {
    await Chat.insertMany(chatDocuments, { ordered: false });
    console.log(`✅ Inserted ${chatDocuments.length} chats`);

    const multi = redisClient.multi();
    chatIds.forEach((id) => {
      multi.del(`chat:delete:${id}`);
      multi.del(`chat:reaction:${id}`);
    });
    await multi.exec();
  } catch (err) {
    console.error("❌ Batch insert error:", err);
  }
};

// Main worker runner
const runChatConsumer = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          // ONLY push to buffer
          messageBuffer.push({ chat: job.data });
        } catch (err) {
          console.error(`❌ Error processing job ${job.id}: ${err.message}`);
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-chat", {
            original: job.data,
            error: err.message,
          });
          throw err;
        }
      },
      {
        connection: bullRedisClient,
        concurrency: CONCURRENCY,
        removeOnComplete: true,
        removeOnFail: { age: 86400 },
        limiter: { max: 200, duration: 5000 },
      }
    );

    // Batch flush every BATCH_INTERVAL
    setInterval(async () => {
      if (messageBuffer.length > 0) {
        const batch = messageBuffer.splice(0, BATCH_SIZE);
        await processBatch(batch);
      }
    }, BATCH_INTERVAL);

    console.log(
      `✅ Chat consumer running for queue: ${QUEUE_NAME} (Concurrency: ${CONCURRENCY})`
    );

    worker.on("error", (err) => console.error("❌ Worker error:", err));
    worker.on("failed", (job, err) =>
      console.error(`❌ Job ${job.id} failed: ${err.message}`)
    );

    return worker;
  } catch (err) {
    console.error("❌ Worker initialization failed:", err);
    throw err;
  }
};

runChatConsumer();

module.exports = { runChatConsumer };
