import express from "express";
import multer from "multer";
import admin from "firebase-admin";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Helper to get bucket after Firebase init
function getBucket() {
  return admin.storage().bucket(process.env.GCS_BUCKET_NAME);
}

// === POST /video/upload ===
router.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const { carId } = req.body;
    if (!req.file || !carId)
      return res.status(400).json({ error: "Missing carId or video file" });

    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const gcsFilename = `${carId}_${sanitized}`;

    const bucket = getBucket(); // ✅ lazy initialization
    const file = bucket.file(gcsFilename);
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype },
      resumable: false,
    });

    console.log(`🎥 Uploaded video for ${carId} to GCS: ${gcsFilename}`);

    const firestore = admin.firestore();
    await firestore.collection(carId).doc("video").set({
      filename: gcsFilename,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, filename: gcsFilename });
  } catch (err) {
    console.error("🔥 /video/upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});


export default router;
