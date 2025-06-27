const mongoose = require("mongoose");

const UniversitySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
});

// Create text index for case-insensitive partial matching
UniversitySchema.index({ name: "text" });

const CitySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  country: {
    type: String,
    required: true,
    trim: true,
  },
});

// Create text index for case-insensitive partial matching on city name
CitySchema.index({ name: "text" });

const University = mongoose.model("University", UniversitySchema);
const City = mongoose.model("City", CitySchema);

module.exports = { University, City };
