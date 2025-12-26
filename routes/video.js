import express from "express";
import multer from "multer";
import { query } from "../tidbConnector.js"; // TiDB connection
import admin from "firebase-admin";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// === POST /video/upload ===
router.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const { carId } = req.body;
    if (!req.file || !carId)
      return res.status(400).json({ error: "Missing carId or video file" });

    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const gcsFilename = `${carId}_${sanitized}`;

    // === Upload to GCS ===
    const bucket = admin.storage().bucket(process.env.GCS_BUCKET_NAME);
    console.log("bucket", bucket);
    const file = bucket.file(gcsFilename);
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype },
      resumable: false,
    });

    console.log(`🎥 Uploaded video for ${carId} to GCS: ${gcsFilename}`);

    // === Insert metadata into TiDB ===
    const result = await query(
      `INSERT INTO car_videos (car_id, filename) VALUES (?, ?)`,
      [carId, gcsFilename]
    );

    console.log("✅ TiDB insert result:", result);

    res.json({ success: true, filename: gcsFilename });
  } catch (err) {
    console.error("🔥 /video/upload error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

export default router;
