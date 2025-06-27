const mongoose = require("mongoose");
const fs = require("fs");
const University = require("../../models/serviceModel"); // Path to your model

// MongoDB connection
const mongoURI = "";
mongoose
  .connect(mongoURI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Path to JSON file
const jsonFilePath = "./file.json";
const BATCH_SIZE = 1000; // Process 1000 records per batch

const importUniversities = async () => {
  try {
    // Read JSON file
    const rawData = fs.readFileSync(jsonFilePath);
    const data = JSON.parse(rawData);

    // Extract unique university names from nested structure
    const universitySet = new Set();
    Object.values(data).forEach((stateArray) => {
      stateArray.forEach((name) => {
        if (name && typeof name === "string") {
          universitySet.add(name.trim());
        }
      });
    });
    const universities = Array.from(universitySet).map((name) => ({ name }));

    console.log(`Found ${universities.length} unique universities`);

    // Bulk insert in batches without deleting existing data
    let insertedCount = 0;
    for (let i = 0; i < universities.length; i += BATCH_SIZE) {
      const batch = universities.slice(i, i + BATCH_SIZE);
      try {
        // Use findOneAndUpdate with upsert to avoid duplicates
        const bulkOps = batch.map((uni) => ({
          updateOne: {
            filter: { name: uni.name },
            update: { $setOnInsert: uni },
            upsert: true,
          },
        }));
        const result = await University.bulkWrite(bulkOps);
        insertedCount += result.upsertedCount || 0;
        console.log(
          `Processed batch ${Math.floor(i / BATCH_SIZE) + 1} (${
            batch.length
          } records, ${result.upsertedCount} new)`
        );
      } catch (err) {
        console.error(
          `Error processing batch ${Math.floor(i / BATCH_SIZE) + 1}:`,
          err
        );
      }
    }

    // Ensure text index exists
    await University.createIndexes();
    console.log("Text index verified on name field");

    // Test query for "Mu"
    const query = "Mu";
    const results = await University.find(
      { $text: { $search: query } },
      { score: { $meta: "textScore" } }
    ).sort({ score: { $meta: "textScore" } });
    console.log(
      `Universities matching "${query}":`,
      results.map((u) => u.name)
    );

    console.log(`Import completed: ${insertedCount} new universities added`);
    mongoose.connection.close();
  } catch (err) {
    console.error("Error during import:", err);
    mongoose.connection.close();
  }
};

importUniversities();
