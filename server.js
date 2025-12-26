import express from "express";
import dotenv from "dotenv";
import allowAllCors from "./corsConfig.js";
import polyline from "@mapbox/polyline";
import fetch from "node-fetch";
import { query, initTables } from "./tidbConnector.js"; // our TiDB connector
import fs from "fs"; 
import path from "path";
import admin from "firebase-admin";
import serviceAccount from "./service-account.json" assert { type: "json" };


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(allowAllCors);
app.use(express.json());

const DIRECTION_API = process.env.DIRECTION_API;
import videoRoutes from "./routes/video.js";
app.use("/video", videoRoutes);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "my-mobileadscar", // your bucket name
});

const bucket = admin.storage().bucket();


async function startServer() {
  // Initialize TiDB tables first
  await initTables();
}

startServer();

// Helper to get Google Maps polyline points
async function getRoutePoints(origin, destination) {
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
    origin
  )}&destination=${encodeURIComponent(destination)}&key=${DIRECTION_API}`;

  const res = await fetch(url);
  const data = await res.json();
  if (!data.routes?.[0]) return [];
  const poly = data.routes[0].overview_polyline.points;
  return polyline.decode(poly).map(([lat, lng]) => ({ lat, lng }));
}

// --------------------- API Routes ---------------------

// GET car route points
app.get("/getcarroute", async (req, res) => {
  const carId = req.query.carId;
  if (!carId) return res.status(400).json({ error: "carId required" });

  try {
    const placesRows = await query(
      `SELECT id, place_name FROM car_places WHERE car_id = ? ORDER BY place_order ASC`,
      [carId]
    );

    if (!placesRows.length)
      return res.status(404).json({ error: "No places found for this car" });

    const segmentPromises = [];
    for (let i = 0; i < placesRows.length; i++) {
      const start = placesRows[i].place_name;
      const end = placesRows[(i + 1) % placesRows.length].place_name;
      segmentPromises.push(getRoutePoints(start, end));
    }

    const segments = await Promise.all(segmentPromises);
    const allPoints = segments.flat();

    res.json(allPoints);
  } catch (err) {
    console.error(`Error building route for car ${carId}:`, err);
    res.status(500).json({ error: "Failed to build route" });
  }
});

// --------------------- Add/Update car places ---------------------
app.post("/addplaces", async (req, res) => {
  try {
    const { carId, places } = req.body;
    if (!carId || !Array.isArray(places) || places.length === 0) {
      return res.status(400).json({ error: "carId and non-empty places[] required" });
    }

    // Delete existing places for the car
    await query(`DELETE FROM car_places WHERE car_id = ?`, [carId]);

    // Insert new places
    for (let i = 0; i < places.length; i++) {
      await query(
        `INSERT INTO car_places (car_id, place_name, place_order) VALUES (?, ?, ?)`,
        [carId, places[i], i]
      );
    }

    res.json({ success: true, carId, places });
  } catch (err) {
    console.error("🔥 /addplaces error:", err);
    res.status(500).json({ error: "Failed to add or update places" });
  }
});

// --------------------- List cars ---------------------
app.get("/listcars", async (req, res) => {
  try {
    // Get all distinct car IDs
    const cars = await query(`SELECT DISTINCT car_id FROM cars`);
    const result = [];

    for (const row of cars) {
      const carId = row.car_id;

      // Fetch ordered places for this car
      const placesRows = await query(
        `SELECT place_name FROM car_places WHERE car_id = ? ORDER BY place_order ASC`,
        [carId]
      );

      // Fetch videos for this car
      const videosRows = await query(
        `SELECT filename, uploaded_at FROM car_videos WHERE car_id = ? ORDER BY uploaded_at DESC`,
        [carId]
      );

      result.push({
        id: carId,
        places: placesRows.map((p) => p.place_name),
        video: videosRows.map((v) => ({
          filename: v.filename
        })),
      });
    }
   console.log("listcarresult", result);
      
    res.json(result);
  } catch (err) {
    console.error("🔥 /listcars error:", err);
    res.status(500).json({ error: "Failed to list cars" });
  }
});

// --------------------- Remove car ---------------------
app.post("/removecar", async (req, res) => {
  try {
    const { carId } = req.body;
    if (!carId) {
      return res.status(400).json({ error: "carId required" });
    }

    console.log(`🗑️ Removing car: ${carId}`);

    // 1️⃣ Get all video filenames for this car
    const videos = await query(
      `SELECT filename FROM car_videos WHERE car_id = ?`,
      [carId]
    );

    // 2️⃣ Delete videos from GCS
    const bucket = admin.storage().bucket(process.env.GCS_BUCKET_NAME);

    for (const v of videos) {
      try {
        console.log(`🎥 Deleting GCS video: ${v.filename}`);
        await bucket.file(v.filename).delete();
      } catch (gcsErr) {
        console.warn(
          `⚠️ GCS delete failed for ${v.filename}:`,
          gcsErr.message
        );
        // DO NOT throw — DB must still be cleaned
      }
    }

    // 3️⃣ Delete video metadata from TiDB
    await query(`DELETE FROM car_videos WHERE car_id = ?`, [carId]);

    // 4️⃣ Delete places
    await query(`DELETE FROM car_places WHERE car_id = ?`, [carId]);

    // 5️⃣ Delete car
    await query(`DELETE FROM cars WHERE car_id = ?`, [carId]);

    console.log(`✅ Car fully removed: ${carId}`);

    res.json({
      success: true,
      removed: carId,
      videosDeleted: videos.length,
    });
  } catch (err) {
    console.error("🔥 /removecar error:", err);
    res.status(500).json({ error: "Failed to remove car" });
  }
});

// server.js
app.post("/registercar", async (req, res) => {
  const { carId } = req.body;
  if (!carId) return res.status(400).json({ error: "carId required" });

  try {
    // Attempt to insert, fail if duplicate
    const result = await query(`INSERT INTO cars (car_id) VALUES (?)`, [carId]);
    
    // If insert succeeds
    res.json({ success: true, carId });
  } catch (err) {
    // Check for duplicate key error
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Car ID already exists" });
    }

    console.error("🔥 /registercar error:", err);
    res.status(500).json({ error: "Failed to register car" });
  }
});


app.get("/syncLatestPositions", async (req, res) => {
  try {
    // 1️⃣ Fetch all latest positions from TiDB
    const latestPositions = await query(
      `SELECT car_id, trip_doc, lat, lng, timestamp FROM car_latest_positions`
    );

    // 2️⃣ Flush Firestore collection
    const collectionRef = firestore.collection("cars_latest_position");
    const docs = await collectionRef.listDocuments();
    const batch = firestore.batch();
    docs.forEach((doc) => batch.delete(doc));
    await batch.commit();

    // 3️⃣ Push all latest positions into Firestore
    const batchInsert = firestore.batch();
    latestPositions.forEach((row) => {
      const docRef = collectionRef.doc(`${row.car_id}_${row.trip_doc}`);
      batchInsert.set(docRef, {
        carId: row.car_id,
        tripDoc: row.trip_doc,
        lat: row.lat,
        lng: row.lng,
        timestamp: row.timestamp,
      });
    });
    await batchInsert.commit();

    res.json({ success: true, count: latestPositions.length });
  } catch (err) {
    console.error("🔥 /syncLatestPositions error:", err);
    res.status(500).json({ error: "Failed to sync latest positions" });
  }
});

app.get("/video/url/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ error: "filename required" });
    }

    // 1️⃣ Validate filename exists in TiDB
    const rows = await query(
      `SELECT id FROM car_videos WHERE filename = ? LIMIT 1`,
      [filename]
    );

    if (rows.length === 0) {
      console.log("❌ Video not found in TiDB:", filename);
      return res.status(404).json({ error: "Video not found" });
    }

    // 2️⃣ Generate signed URL from GCS
    const bucket = admin.storage().bucket(process.env.GCS_BUCKET_NAME);
    const file = bucket.file(filename);

    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    console.log("✅ Signed URL generated for:", filename);

    res.json({ url });
  } catch (err) {
    console.error("🔥 /video/url error:", err);
    res.status(500).json({ error: "Failed to get video URL" });
  }
});

// --------------------- Start server ---------------------
app.listen(PORT, () => console.log(`🚗 Server running on port ${PORT}`));
