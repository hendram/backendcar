import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import db from "../db.js"; 

const router = express.Router();

const videoDir = path.join(process.cwd(), "videos");
if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videoDir),
  filename: (req, file, cb) => {
    const carId = req.body.carId || "unknown";
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const filename = `${carId}_${sanitized}`;
    cb(null, filename);
  },
});
const upload = multer({ storage });

// === POST /video/upload ===
router.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const { carId } = req.body;
    if (!req.file || !carId)
      return res.status(400).json({ error: "Missing carId or video file" });

    const savedFilename = req.file.filename;
    console.log(`🎥 Uploaded video for ${carId}: ${savedFilename}`);

    const dbConn = await db;

    await dbConn.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        car_id TEXT PRIMARY KEY,
        filename TEXT
      )
    `);

  const result = await dbConn.run(
    `INSERT OR REPLACE INTO videos (car_id, filename)
     VALUES (?, ?)`,
    [carId, savedFilename]
  );

  if (result.changes > 0) {
    console.log(`✅ Video saved successfully for car_id=${carId}, filename=${savedFilename}`);
  } else {
    console.log(`⚠️ No changes made for car_id=${carId}, filename=${savedFilename}`);
  }

    res.json({ success: true, filename: savedFilename });
  } catch (err) {
    console.error("🔥 /video/upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
