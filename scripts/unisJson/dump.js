const mongoose = require("mongoose");
const fs = require("fs");
const University = require("../../models/serviceModel"); // Path to your model

// MongoDB connection (replace with your MongoDB URI)
const mongoURI = "";
mongoose
  .connect(mongoURI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Path to your JSON file
const jsonFilePath = "./file.json";
const BATCH_SIZE = 1000; // Process 1000 records per batch

const importUniversities = async () => {
  try {
    // Read JSON file
    const rawData = fs.readFileSync(jsonFilePath);
    const data = JSON.parse(rawData);

    // Extract unique university names
    const universitySet = new Set(data.map((item) => item.university.trim()));
    const universities = Array.from(universitySet).map((name) => ({ name }));

    console.log(`Found ${universities.length} unique universities`);

    // Clear existing data (optional, remove if appending)
    // await University.deleteMany({});
    // console.log("Cleared existing universities");

    // Bulk insert in batches
    for (let i = 0; i < universities.length; i += BATCH_SIZE) {
      const batch = universities.slice(i, i + BATCH_SIZE);
      try {
        await University.insertMany(batch, { ordered: false });
        console.log(
          `Inserted batch ${Math.floor(i / BATCH_SIZE) + 1} (${
            batch.length
          } records)`
        );
      } catch (err) {
        console.error(
          `Error inserting batch ${Math.floor(i / BATCH_SIZE) + 1}:`,
          err
        );
      }
    }

    // Ensure text index is created
    await University.createIndexes();
    console.log("Text index created on name field");

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

    console.log("Import completed successfully");
    mongoose.connection.close();
  } catch (err) {
    console.error("Error during import:", err);
    mongoose.connection.close();
  }
};

importUniversities();
