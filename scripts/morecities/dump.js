const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { City } = require("../../models/serviceModel"); // Adjust path to your model file

// MongoDB connection URI
const mongoURI = "";
("");

// Batch size for writes
const BATCH_SIZE = 1000;

// Connect to MongoDB
mongoose
  .connect(mongoURI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// Function to dump data in batches
const dumpData = async () => {
  try {
    // Load JSON data from file
    const rawData = fs.readFileSync(path.resolve(__dirname, "cities.json"));
    const citiesData = JSON.parse(rawData);
    console.log(`Total cities to process: ${citiesData.length}`);

    // Process data in batches
    for (let i = 0; i < citiesData.length; i += BATCH_SIZE) {
      const batch = citiesData.slice(i, i + BATCH_SIZE).map((city) => ({
        name: city.name,
        country: city.country,
      }));

      try {
        await City.insertMany(batch, { ordered: false });
        console.log(
          `Inserted batch ${i / BATCH_SIZE + 1}: ${batch.length} cities`
        );
      } catch (batchErr) {
        console.error(
          `Error inserting batch ${i / BATCH_SIZE + 1}:`,
          batchErr.message
        );
      }
    }

    console.log("Data successfully dumped into MongoDB");

    // Close the MongoDB connection
    await mongoose.connection.close();
    console.log("MongoDB connection closed");
    process.exit(0);
  } catch (err) {
    console.error("Error dumping data into MongoDB:", err);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the script
dumpData();
