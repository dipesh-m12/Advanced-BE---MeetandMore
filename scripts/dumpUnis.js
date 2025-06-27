const mongoose = require("mongoose");
const csv = require("csv-parser");
const fs = require("fs");
const University = require("../models/serviceModel"); // Path to your model
// MongoDB connection (replace with your MongoDB URI)
const mongoURI = "";
mongoose
  .connect(mongoURI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Path to your CSV file
const csvFilePath = "./Welcome to UGC, New Delhi, India.csv";

const importUniversities = async () => {
  const universities = [];

  // Read CSV file
  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on("data", (row) => {
      const name = row["Name of the University"]?.trim();
      if (name) {
        universities.push({ name });
      }
    })
    .on("end", async () => {
      try {
        // Clear existing data (optional, remove if you want to append)
        await University.deleteMany({});

        // Insert universities, ignoring duplicates
        await University.insertMany(universities, { ordered: false })
          .then(() =>
            console.log(`Inserted ${universities.length} universities`)
          )
          .catch((err) => console.error("Error inserting universities:", err));

        // Ensure text index is created
        await University.createIndexes();
        console.log("Text index created on name field");

        // Example query for "Mu"
        const query = "Mu";
        const results = await University.find(
          { $text: { $search: query } },
          { score: { $meta: "textScore" } }
        ).sort({ score: { $meta: "textScore" } });
        console.log(
          `Universities matching "${query}":`,
          results.map((u) => u.name)
        );

        mongoose.connection.close();
      } catch (err) {
        console.error("Error during import:", err);
        mongoose.connection.close();
      }
    })
    .on("error", (err) => {
      console.error("Error reading CSV:", err);
      mongoose.connection.close();
    });
};

importUniversities();
