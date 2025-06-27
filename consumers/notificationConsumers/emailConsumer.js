const Redis = require("ioredis");
const sendBulkEmails = require("../../emailService/emailService");
const { Worker, Queue } = require("bullmq");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null, // 🔥 THIS IS REQUIRED FOR BullMQ
  }
);

const QUEUE_NAME = "bulk-email";
const BATCH_SIZE = 100;
const BATCH_INTERVAL = 5000;
const CONCURRENCY = 1;

const emailBuffer = [];

const processBatch = async () => {
  if (emailBuffer.length === 0) return;

  const batch = emailBuffer.splice(0, Math.min(BATCH_SIZE, emailBuffer.length));

  try {
    await sendBulkEmails(batch);
    console.log(
      `📤 Sent ${batch.length} emails to: ${batch.map((e) => e.to).join(", ")}`
    );
  } catch (err) {
    console.error(`🚨 Batch failed for ${batch.length} emails: ${err.message}`);
    emailBuffer.unshift(...batch);
    throw err;
  }
};

const runEmailWorker = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          const payload = job.data;
          if (!payload.to || !payload.subject) {
            console.warn(`⚠️ Invalid job ${job.id}: missing required fields`);
            return;
          }

          emailBuffer.push(payload);

          if (emailBuffer.length >= BATCH_SIZE) {
            await processBatch();
          }
        } catch (err) {
          console.error(`❌ Error processing job ${job.id}: ${err.message}`);
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-email", {
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

    setInterval(async () => {
      if (emailBuffer.length > 0) {
        await processBatch();
      }
    }, BATCH_INTERVAL);

    console.log(
      `✅ Group assignment worker started for queue: ${QUEUE_NAME} (Concurrency: ${CONCURRENCY})`
    );

    worker.on("error", (err) => console.error("❌ Worker error:", err));
    worker.on("failed", (job, err) =>
      console.error(`❌ Job ${job.id} failed: ${err.message}`)
    );

    return worker;
  } catch (err) {
    console.error("❌ Worker failed:", err);
    throw err;
  }
};

runEmailWorker();
module.exports = { runEmailWorker };
