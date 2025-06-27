const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const currencies = require("../utils/data");

const UserSchema = new mongoose.Schema(
  {
    _id: {
      type: String, // <-- This is critical to allow UUIDs
      required: true,
    },
    country_code: {
      type: String,
      required: [true, "Country code is required"],
      trim: true,
      match: [/^\+\d{1,3}$/, "Invalid country code format"],
    },
    phone_number: {
      type: String,
      required: [true, "Phone number is required"],
      unique: true,
      trim: true,
      match: [/^\d{10}$/, "Phone number must be 10 digits"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      // unique: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email format"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
    },
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
    },
    dob: {
      type: Date,
      required: [true, "Date of birth is required"],
    },
    city: {
      type: String,
      required: [true, "City is required"],
      trim: true,
    },
    location: {
      type: String,
      trim: true,
    },
    loc_coords: {
      lats: {
        type: Number,
        required: [true, "Latitude is required"],
      },
      longs: {
        type: Number,
        required: [true, "Longitude is required"],
      },
    },
    university: {
      type: String,
      // required: [true, "University is required"],
      trim: true,
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      required: [true, "Gender is required"],
    },
    pushtoken: {
      type: String,
      trim: true,
    },
    referralcode: {
      type: String,
      default: () => {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let code = "";
        for (let i = 0; i < 6; i++) {
          code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
      },
      unique: true,
    },
    avatar: {
      type: String,
      trim: true,
    },
    deactivated: {
      type: Boolean,
      default: false,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    region_currency: {
      type: String,
      enum: currencies,
      default: "INR", // Default to INR if geolocation fails
    },
    hasAvailedFirstTimeDiscount: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Define indexes
// UserSchema.index({ phone_number: 1 }, { unique: true }); // Unique index for phone number
// UserSchema.index({ referralcode: 1 }, { unique: true }); // Unique index for referral code
UserSchema.index({ "loc_coords.lats": 1, "loc_coords.longs": 1 }); // Compound index for geospatial queries
UserSchema.index({ deactivated: 1 }); // Index for filtering active/deactivated users
UserSchema.index({ deleted: 1 }); // Index for filtering deleted users
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { deleted: false } }
); // Partial unique index for active accounts
UserSchema.index({ loc_coords: "2dsphere" }, { name: "loc_coords_2dsphere" });

module.exports = mongoose.model("Profile", UserSchema);
