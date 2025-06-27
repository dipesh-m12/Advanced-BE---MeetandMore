const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const currencies = require("../utils/data");

const VenueCitySchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    city_name: {
      type: String,
      required: [true, "City name is required"],
      trim: true,
      unique: true,
    },
    region_currency: {
      type: String,
      enum: currencies,
      required: [true, "Region currency is required"],
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    timezone: {
      type: String,
      required: [true, "Timezone is required"],
    },
  },
  { timestamps: true }
);

// Indexes for VenueCity
// VenueCitySchema.index({ city_name: 1 }, { unique: true });
VenueCitySchema.index({ region_currency: 1 });

// Static method to initialize default cities
VenueCitySchema.statics.initializeDefaultCities = async function () {
  const defaultCities = [
    {
      city_name: "New Delhi",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Mumbai",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Bangalore",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Chennai",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Hyderabad",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Ahmedabad",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Kolkata",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Pune",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "Goa",
      region_currency: "INR",
      amount: 600,
      timezone: "Asia/Kolkata",
    },
    {
      city_name: "New York",
      region_currency: "USD",
      amount: 20,
      timezone: "America/New_York",
    },
    {
      city_name: "Los Angeles",
      region_currency: "USD",
      amount: 20,
      timezone: "America/Los_Angeles",
    },
    {
      city_name: "Chicago",
      region_currency: "USD",
      amount: 20,
      timezone: "America/Chicago",
    },
    {
      city_name: "San Francisco",
      region_currency: "USD",
      amount: 20,
      timezone: "America/Los_Angeles",
    },
    {
      city_name: "Toronto",
      region_currency: "CAD",
      amount: 15,
      timezone: "America/Toronto",
    },
    {
      city_name: "Montreal",
      region_currency: "CAD",
      amount: 15,
      timezone: "America/Montreal",
    },
    {
      city_name: "Vancouver",
      region_currency: "CAD",
      amount: 15,
      timezone: "America/Vancouver",
    },
    {
      city_name: "Quebec",
      region_currency: "CAD",
      amount: 15,
      timezone: "America/Montreal",
    },
    {
      city_name: "London",
      region_currency: "GBP",
      amount: 14,
      timezone: "Europe/London",
    },
    {
      city_name: "Paris",
      region_currency: "EUR",
      amount: 16,
      timezone: "Europe/Paris",
    },
    {
      city_name: "Berlin",
      region_currency: "EUR",
      amount: 16,
      timezone: "Europe/Berlin",
    },
    {
      city_name: "Frankfurt",
      region_currency: "EUR",
      amount: 16,
      timezone: "Europe/Berlin",
    },
    {
      city_name: "Munich",
      region_currency: "EUR",
      amount: 16,
      timezone: "Europe/Berlin",
    },
    {
      city_name: "Melbourne",
      region_currency: "AUD",
      amount: 15,
      timezone: "Australia/Melbourne",
    },
    {
      city_name: "Sydney",
      region_currency: "AUD",
      amount: 15,
      timezone: "Australia/Sydney",
    },
    {
      city_name: "Brisbane",
      region_currency: "AUD",
      amount: 15,
      timezone: "Australia/Brisbane",
    },
    {
      city_name: "Adelaide",
      region_currency: "AUD",
      amount: 15,
      timezone: "Australia/Adelaide",
    },
    {
      city_name: "Singapore",
      region_currency: "SGD",
      amount: 30,
      timezone: "Asia/Singapore",
    },
    {
      city_name: "Hong Kong",
      region_currency: "HKD",
      amount: 100,
      timezone: "Asia/Hong_Kong",
    },
    {
      city_name: "Tokyo",
      region_currency: "JPY",
      amount: 1400,
      timezone: "Asia/Tokyo",
    },
    {
      city_name: "Seoul",
      region_currency: "KRW",
      amount: 12000,
      timezone: "Asia/Seoul",
    },
    {
      city_name: "Kuala Lumpur",
      region_currency: "MYR",
      amount: 30,
      timezone: "Asia/Kuala_Lumpur",
    },
    {
      city_name: "Bangkok",
      region_currency: "THB",
      amount: 400,
      timezone: "Asia/Bangkok",
    },
    {
      city_name: "Dubai",
      region_currency: "AED",
      amount: 50,
      timezone: "Asia/Dubai",
    },
    {
      city_name: "Abu Dhabi",
      region_currency: "AED",
      amount: 50,
      timezone: "Asia/Dubai",
    },
    {
      city_name: "Doha",
      region_currency: "QAR",
      amount: 40,
      timezone: "Asia/Qatar",
    },
    {
      city_name: "Riyadh",
      region_currency: "SAR",
      amount: 40,
      timezone: "Asia/Riyadh",
    },
    {
      city_name: "Cairo",
      region_currency: "EGP",
      amount: 300,
      timezone: "Africa/Cairo",
    },
    {
      city_name: "Cape Town",
      region_currency: "ZAR",
      amount: 230,
      timezone: "Africa/Johannesburg",
    },
    {
      city_name: "Buenos Aires",
      region_currency: "ARS",
      amount: 1200,
      timezone: "America/Argentina/Buenos_Aires",
    },
    {
      city_name: "Mexico City",
      region_currency: "MXN",
      amount: 200,
      timezone: "America/Mexico_City",
    },
    {
      city_name: "Lagos",
      region_currency: "NGN",
      amount: 3000,
      timezone: "Africa/Lagos",
    },
    {
      city_name: "Johannesburg",
      region_currency: "ZAR",
      amount: 230,
      timezone: "Africa/Johannesburg",
    },
    {
      city_name: "Moscow",
      region_currency: "RUB",
      amount: 1000,
      timezone: "Europe/Moscow",
    },
    {
      city_name: "Istanbul",
      region_currency: "TRY",
      amount: 150,
      timezone: "Europe/Istanbul",
    },
    {
      city_name: "Santiago",
      region_currency: "CLP",
      amount: 7000,
      timezone: "America/Santiago",
    },
    {
      city_name: "Rio de Janeiro",
      region_currency: "BRL",
      amount: 35,
      timezone: "America/Sao_Paulo",
    },
    {
      city_name: "Lima",
      region_currency: "PEN",
      amount: 30,
      timezone: "America/Lima",
    },
    {
      city_name: "Bogotá",
      region_currency: "COP",
      amount: 30000,
      timezone: "America/Bogota",
    },
    {
      city_name: "Kigali",
      region_currency: "RWF",
      amount: 7000,
      timezone: "Africa/Kigali",
    },
    {
      city_name: "Nairobi",
      region_currency: "KES",
      amount: 1000,
      timezone: "Africa/Nairobi",
    },
    {
      city_name: "Abuja",
      region_currency: "NGN",
      amount: 3000,
      timezone: "Africa/Lagos",
    },
    {
      city_name: "Dhaka",
      region_currency: "BDT",
      amount: 800,
      timezone: "Asia/Dhaka",
    },
  ];

  for (const city of defaultCities) {
    await this.findOneAndUpdate({ city_name: city.city_name }, city, {
      upsert: true,
      new: true,
    });
  }
};

const VenueSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    city: {
      type: String,
      ref: "VenueCity",
      required: [true, "City is required"],
    },
    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
      unique: true, // <-- Make address unique
    },
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    active: {
      type: Boolean,
      default: false,
    },
    preventFutureBooking: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Indexes for Venue
VenueSchema.index({ city: 1 });
VenueSchema.index({ active: 1 });
VenueSchema.index({ city: 1, active: 1 }); // Compound index
// VenueSchema.index({ address: 1 }, { unique: true });

// Static method to ensure only one venue is active per city
VenueSchema.statics.deactivateOtherVenues = async function (cityId, venueId) {
  await this.updateMany(
    { city: cityId, _id: { $ne: venueId }, active: true },
    { $set: { active: false } }
  );
};

const VenueCity = mongoose.model("VenueCity", VenueCitySchema);
const Venue = mongoose.model("Venue", VenueSchema);

module.exports = { VenueCity, Venue, VenueCitySchema };
