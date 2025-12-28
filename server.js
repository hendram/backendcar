import express from "express";
import dotenv from "dotenv";
import allowAllCors from "./corsConfig.js";
import polyline from "@mapbox/polyline";
import fetch from "node-fetch";
import { query, initTables } from "./tidbConnector.js"; // our TiDB connector
import fs from "fs"; 
import path from "path";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(allowAllCors);
app.use(express.json());

const DIRECTION_API = process.env.DIRECTION_API;
import videoRoutes from "./routes/video.js";
app.use("/video", videoRoutes);

admin.initializeApp({
  credential: admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS),
  storageBucket: "my-mobileadscar", // your bucket name
});

const bucket = admin.storage().bucket();

const firestore = admin.firestore();

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


const currentDocuments = {}; // for Firestore document tracking

function getDocumentName(carId, forceNew) {
  if (currentDocuments[carId] && !forceNew) {
    return currentDocuments[carId];
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  const docName = `${carId}_${timestamp}`;
  currentDocuments[carId] = docName;
  return docName;
}

// --- Firestore logging ---
async function logPositionToFirestore(carId, lat, lng, newTrip) {
  const docName = getDocumentName(carId, newTrip);
  const timestamp = new Date().toISOString();
  const collectionRef = firestore.collection("cars_latest_position");

  const docRef = collectionRef.doc(docName);
  const docSnapshot = await docRef.get();

  if (!docSnapshot.exists) {
    await docRef.set({ carId, lat, lng, timestamp });
  } else {
    const subDocId = timestamp.replace(/[:.]/g, "");
    await docRef.collection("positions").doc(subDocId).set({ carId, lat, lng, timestamp });
  }

  return docName;
}

async function upsertLatestPosition(carId, tripDoc, lat, lng) {
  await query(
    `INSERT INTO car_latest_positions (car_id, trip_doc, lat, lng)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       trip_doc = VALUES(trip_doc),
       lat = VALUES(lat),
       lng = VALUES(lng),
       timestamp = CURRENT_TIMESTAMP`,
    [carId, tripDoc, lat, lng]
  );
}


// --- TiDB trip legs creation using Directions API ---
async function createTripLegs(carId, places, startTime) {
  const legs = [];

  // Generate leg info for each pair of places
  for (let i = 0; i < places.length; i++) {
    const origin = places[i];
    const destination = places[(i + 1) % places.length]; // loop around
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
      origin
    )}&destination=${encodeURIComponent(destination)}&key=${DIRECTION_API}`;

    const res = await fetch(url);
    const data = await res.json();

    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) {
      console.warn(`No leg found for ${origin} → ${destination}`);
      continue;
    }

    legs.push({
      origin,
      destination,
      distance_m: leg.distance.value,
      duration_s: leg.duration.value,
    });
  }

  // Compute ETA timestamps
  let currentTime = new Date(startTime);
  const tripCollection = `${carId}_${currentTime.toISOString().replace(/[:.]/g, "")}`;

  for (let i = 0; i < legs.length; i++) {
    currentTime = new Date(currentTime.getTime() + legs[i].duration_s * 1000);

    await query(
      `INSERT INTO car_trip_legs (car_id, trip_collection, leg_index, origin, destination, distance_m, duration_s, eta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        carId,
        tripCollection,
        i + 1,
        legs[i].origin,
        legs[i].destination,
        legs[i].distance_m,
        legs[i].duration_s,
        currentTime.toISOString(),
      ]
    );
  }

  return tripCollection;
}

app.post("/carcurpos", async (req, res) => {
  try {
    const { carId, lat, lng, newTrip } = req.body;
    if (!carId || typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "Missing carId, lat, or lng" });
    }

    const tripDoc = getDocumentName(carId, newTrip);

if (newTrip) {
  const placesRows = await query(
    `SELECT place_name FROM car_places WHERE car_id = ? ORDER BY place_order ASC`,
    [carId]
  );
  const places = placesRows.map((p) => p.place_name);
  if (places.length > 1) {
    const tripCollection = await createTripLegs(carId, places, new Date().toISOString());
  }
}

    // --- 2️⃣ Upsert latest position in TiDB ---
    await query(
      `INSERT INTO car_latest_positions (car_id, trip_doc, lat, lng)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         trip_doc = VALUES(trip_doc),
         lat = VALUES(lat),
         lng = VALUES(lng),
         timestamp = CURRENT_TIMESTAMP`,
      [carId, tripDoc, lat, lng]
    );

    // --- 3️⃣ Log current position to Firestore for mobile realtime display ---
    const collectionRef = firestore.collection("cars_latest_position");
    const docRef = collectionRef.doc(tripDoc);
    const timestamp = new Date().toISOString();
    const docSnapshot = await docRef.get();

    if (!docSnapshot.exists) {
      await docRef.set({ carId, lat, lng, timestamp });
    } else {
      const subDocId = timestamp.replace(/[:.]/g, "");
      await docRef.collection("positions").doc(subDocId).set({ carId, lat, lng, timestamp });
    }

    res.json({ success: true, carId, tripDoc });
  } catch (err) {
    console.error("🔥 /carcurpos error:", err);
    res.status(500).json({ error: "Failed to process car position" });
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
    await flushLatestPositions();
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

async function flushLatestPositions() {
  const collectionRef = firestore.collection("cars_latest_position");
  const docs = await collectionRef.listDocuments();

  if (docs.length === 0) return;

  const batch = firestore.batch();
  docs.forEach((doc) => batch.delete(doc));
  await batch.commit();

  console.log(`Flushed ${docs.length} latest positions`);
}

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
