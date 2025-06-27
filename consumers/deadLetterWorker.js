const Redis = require("ioredis");
const { Worker, Queue } = require("bullmq");
const mongoose = require("mongoose");
const { sendMessageToKafka } = require("../utils/kafka");
const DeadLetterLogs = require("../models/deadLetterLogModel");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null,
  }
);

const QUEUE_NAME = "dead-letter";
const CONCURRENCY = 1;

const runDeadLetterWorker = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          const { original, error } = job.data;

          // Log to MongoDB
          await DeadLetterLogs.create({
            queueName: job.name,
            originalData: original,
            error,
          });

          // Notify admins
          await sendMessageToKafka("bulk-email", {
            to: process.env.EMAIL_USER || "mavinash422@gmail.com",
            subject: `Dead-Letter Queue Alert: ${job.name}`,
            templateName: "dead-letter-notification",
            data: {
              queueName: job.name,
              originalData: JSON.stringify(original, null, 2),
              error,
            },
          });

          console.log(`Processed DLQ job ${job.id}: ${job.name}`);
        } catch (err) {
          console.error(`Error processing DLQ job ${job.id}: ${err.message}`);
        }
      },
      {
        connection: bullRedisClient,
        concurrency: CONCURRENCY,
        removeOnComplete: true,
        removeOnFail: { age: 86400 },
      }
    );

    console.log(`✅ Dead-letter worker started for queue: ${QUEUE_NAME}`);

    worker.on("error", (err) => console.error("Worker error:", err));
    worker.on("failed", (job, err) =>
      console.error(`Job ${job.id} failed: ${err.message}`)
    );

    return worker;
  } catch (err) {
    console.error("Worker failed:", err);
    throw err;
  }
};

runDeadLetterWorker();
module.exports = { runDeadLetterWorker };
