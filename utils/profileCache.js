const redis = require("redis");
const Profile = require("../models/authModel");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const safeRedis = async (fn, operationName) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`Redis error in ${operationName}:`, err);
    throw err;
  }
};

async function getUserNames(userIds) {
  try {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return new Map();
    }

    const uniqueIds = [...new Set(userIds)];
    const redisKeys = uniqueIds.map((id) => `profile:name:${id}`);
    const cachedNames = await safeRedis(
      () => redisClient.mGet(redisKeys),
      `mget profile names for ${uniqueIds.length} users`
    );

    const userNames = new Map();
    const missingIds = [];

    cachedNames.forEach((name, index) => {
      const userId = uniqueIds[index];
      if (name) {
        userNames.set(userId, name);
      } else {
        missingIds.push(userId);
      }
    });

    if (missingIds.length > 0) {
      const profiles = await Profile.find(
        { _id: { $in: missingIds } },
        "name"
      ).lean();
      // console.log(profiles);
      const multi = redisClient.multi();
      profiles.forEach((profile) => {
        userNames.set(profile._id, profile.name);
        multi.setEx(`profile:name:${profile._id}`, 86400, profile.name);
      });

      missingIds.forEach((id) => {
        if (!profiles.some((p) => p._id === id)) {
          userNames.set(id, null);
          multi.setEx(`profile:name:${id}`, 86400, "");
        }
      });

      await safeRedis(
        () => multi.exec(),
        `cache names for ${missingIds.length} users`
      );
    }

    return userNames;
  } catch (err) {
    console.error("Error fetching user names:", err);
    return new Map(userIds.map((id) => [id, null]));
  }
}

module.exports = { getUserNames };
