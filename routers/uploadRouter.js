const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const { Storage } = require("@google-cloud/storage");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const crypto = require("crypto");
const verifyJWT = require("../middlewares/verifyJWT");

const router = express.Router();
router.use(verifyJWT);

// Configure multer to use memory storage (buffer)
const upload = multer({ storage: multer.memoryStorage() });

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Initialize S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper: Upload buffer to Cloudinary (returns Promise)
function uploadToCloudinary(buffer, originalname) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "MeetAndMore",
        resource_type: "image",
        public_id: path.parse(originalname).name + "-" + Date.now(),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// Helper to generate unique file name
function generateFileName(originalname) {
  const ext = path.extname(originalname);
  const base = crypto.randomBytes(16).toString("hex");
  return `${base}${ext}`;
}

// Cloudinary upload route
router.post("/cloudinary", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        data: null,
        message: "No file uploaded. Please attach a file.",
        success: false,
      });
    }

    const result = await uploadToCloudinary(
      req.file.buffer,
      req.file.originalname
    );

    return res.status(200).json({
      data: {
        url: result.secure_url,
        public_id: result.public_id,
      },
      message: "File uploaded successfully to Cloudinary",
      success: true,
    });
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    return res.status(500).json({
      data: null,
      message: "Internal server error while uploading file to Cloudinary.",
      success: false,
    });
  }
});

// Upload route - saves file to S3 in avatarsv folder with public read access
router.post("/s3", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "No file uploaded" });
  }

  const fileName = generateFileName(req.file.originalname);

  try {
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `avatarsv/${fileName}`, // Store in avatarsv folder
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      // ACL: "public-read", // Makes the object publicly readable
    };

    const command = new PutObjectCommand(uploadParams);
    await s3.send(command);

    const fileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/avatarsv/${fileName}`;

    res.status(200).json({
      success: true,
      message: "File uploaded successfully",
      url: fileUrl,
      key: `avatarsv/${fileName}`, // Return key with folder for deletion
    });
  } catch (error) {
    console.error("S3 Upload Error:", error);
    res.status(500).json({ success: false, message: "Failed to upload to S3" });
  }
});

// Delete route - deletes file from S3 given the object key
router.delete("/s3/:key", async (req, res) => {
  const { key } = req.params;

  if (!key) {
    return res
      .status(400)
      .json({ success: false, message: "Missing file key parameter" });
  }

  try {
    const deleteParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `avatarsv/${key}`, // Key includes avatarsv/ prefix (e.g., avatarsv/<filename>)
    };

    const command = new DeleteObjectCommand(deleteParams);
    await s3.send(command);

    res.status(200).json({
      success: true,
      message: `File deleted successfully: ${key}`,
    });
  } catch (error) {
    console.error("S3 Delete Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete file from S3" });
  }
});

module.exports = router;
