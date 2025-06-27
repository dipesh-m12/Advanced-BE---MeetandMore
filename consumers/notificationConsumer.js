const Redis = require("ioredis");
const admin = require("firebase-admin");
const { Worker, Queue } = require("bullmq");

const bullRedisClient = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectTimeout: 10000,
    maxRetriesPerRequest: null, // 🔥 THIS IS REQUIRED FOR BullMQ
  }
);

const QUEUE_NAME = "notification-batch";
const CONCURRENCY = 1;

const runNotificationWorker = async () => {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          const { tokens, title, body, data } = job.data;
          if (!tokens?.length || !title || !body) {
            console.warn(`⚠️ Invalid job ${job.id}: missing required fields`);
            return;
          }

          const chunkSize = 500;
          const tokenChunks = [];
          for (let i = 0; i < tokens.length; i += chunkSize) {
            tokenChunks.push(tokens.slice(i, i + chunkSize));
          }

          const results = await Promise.all(
            tokenChunks.map(async (chunk) => {
              const multicastMessage = {
                notification: { title, body },
                data: data || {},
                tokens: chunk,
              };

              const response = await admin
                .messaging()
                .sendEachForMulticast(multicastMessage);
              const successes = response.responses.filter(
                (r) => r.success
              ).length;
              const failures = response.responses.filter((r) => !r.success);

              return {
                successes,
                failures: failures.map((fail, idx) => ({
                  token: chunk[idx],
                  error: fail.error?.message,
                })),
              };
            })
          );

          const totalSuccesses = results.reduce(
            (sum, r) => sum + r.successes,
            0
          );
          const totalFailures = results.reduce(
            (sum, r) => sum + r.failures.length,
            0
          );
          console.log(
            `✅ Sent: ${totalSuccesses}, ❌ Failed: ${totalFailures}`
          );

          if (totalFailures > 0) {
            const deadQueue = new Queue("dead-letter", {
              connection: bullRedisClient,
            });
            for (const result of results) {
              for (const failure of result.failures) {
                console.error(
                  `❌ Token: ${failure.token}, Error: ${failure.error}`
                );
                await deadQueue.add("failed-notification", {
                  original: { token: failure.token, title, body, data },
                  error: failure.error,
                });
              }
            }
          }
        } catch (err) {
          console.error(`❌ Error processing job ${job.id}: ${err.message}`);
          const deadQueue = new Queue("dead-letter", {
            connection: bullRedisClient,
          });
          await deadQueue.add("failed-notification", {
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
        limiter: { max: 100, duration: 5000 },
      }
    );

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

runNotificationWorker();
module.exports = { runNotificationWorker };
