const mongoose = require("mongoose");
const Profile = require("../../models/authModel"); // Adjust path to your Profile model
const { MongoClient } = require("mongodb");

const ATLAS_URI = process.env.MONGO_ATLAS_URI || "";
const LOCAL_MONGO_URI =
  process.env.LOCAL_MONGO_URI || "mongodb://127.0.0.1:27017/meetandmore";

async function syncProfiles() {
  let atlasConnection, localClient;
  try {
    // Connect to MongoDB Atlas
    atlasConnection = await mongoose.connect(ATLAS_URI);
    console.log("Connected to MongoDB Atlas");

    // Connect to local MongoDB
    localClient = new MongoClient(LOCAL_MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    await localClient.connect();
    console.log("Connected to local MongoDB");
    const localDb = localClient.db("meetandmore");
    const localProfiles = localDb.collection("profiles");

    // Fetch all profiles from Atlas
    const profiles = await Profile.find({ deleted: false }).lean();
    console.log(`Fetched ${profiles.length} profiles from Atlas`);

    // Upsert profiles to local MongoDB
    const bulkOps = profiles.map((profile) => ({
      updateOne: {
        filter: { _id: profile._id },
        update: { $set: profile },
        upsert: true,
      },
    }));

    if (bulkOps.length > 0) {
      const result = await localProfiles.bulkWrite(bulkOps);
      console.log(
        `Synced profiles: ${result.upsertedCount} upserted, ${result.modifiedCount} modified`
      );
    } else {
      console.log("No profiles to sync");
    }
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    if (err.name === "MongoServerSelectionError") {
      console.error("Check if local MongoDB is running on 127.0.0.1:27017");
      console.error(
        "Try starting MongoDB with: docker run -d --name mongodb -p 27017:27017 mongodb:5"
      );
    }
    throw err;
  } finally {
    // Clean up connections
    if (atlasConnection) await mongoose.disconnect();
    if (localClient) await localClient.close();
    console.log("Disconnected from databases");
  }
}

syncProfiles()
  .then(() => {
    console.log("Sync completed successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Sync process exited with error:", err);
    process.exit(1);
  });
