import express from "express";
import dotenv from "dotenv";
import allowAllCors from "./corsConfig.js";
import polyline from "@mapbox/polyline";
import fetch from "node-fetch";
import serviceAccount from "./serviceAccountKey.json" with { type: "json" };
import fs from "fs"; 
import path from "path";
import dbPromise, { initDb } from "./db.js";
import videoRoutes from "./routes/video.js";
import admin from "firebase-admin";

dotenv.config();
await initDb(); 

const app = express();
const PORT = 3001;
app.use(allowAllCors);
app.use(express.json());
app.use("/video", videoRoutes);

// --- Initialize Firebase Admin (Firestore) ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();

// --- Helper functions for routes ---
const DIRECTION_API = process.env.DIRECTION_API;
// --- Gemini & DistanceMatrix ETA simulation ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DISTANCE_MATRIX_API = process.env.DISTANCE_MATRIX_API;

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

let clients = [];

// 1️⃣ Frontend connects here (SSE)
app.get("/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Push new client
  clients.push(res);
  console.log("👂 Client connected:", clients.length);

  // 🔄 Send a heartbeat every 20 minutes
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`); // comment line, ignored by browser
  }, 20 * 60 * 1000); // 20 minutes

  // Clean up when client disconnects
  req.on("close", () => {
    clearInterval(heartbeat);
    clients = clients.filter(c => c !== res);
    console.log("❌ Client disconnected:", clients.length);
  });
});

// 2️⃣ ADK sends message here
app.post("/adksend", (req, res) => {
  const data = req.body; // e.g. { carId, expectedTime }
  console.log("📨 Message from ADK:", data);

  // Broadcast message to all connected SSE clients
  clients.forEach(c => {
    c.write(`data: ${JSON.stringify(data)}\n\n`);
  });

  res.json({ ok: true });
});


app.get("/getcarroute", async (req, res) => {
  const carId = req.query.carId;
  if (!carId) return res.status(400).json({ error: "carId required" });

  try {
    const db = await dbPromise;
    const rows = await db.all(
      `SELECT name FROM places WHERE car_id = ? ORDER BY id ASC`,
      [carId]
    );
    const places = rows.map(r => r.name);

    if (places.length === 0)
      return res.status(404).json({ error: "No places found for this car" });

    // Build route segments in parallel
    const segmentPromises = [];
    for (let i = 0; i < places.length; i++) {
      const start = places[i];
      const end = places[(i + 1) % places.length]; // loop back to start
      segmentPromises.push(getRoutePoints(start, end));
    }

    // Wait for all segments
    const segments = await Promise.all(segmentPromises);

    // Flatten array of arrays into a single array of points
    const allPoints = segments.flat();

    res.json(allPoints);
  } catch (err) {
    console.error(`Error building route for car ${carId}:`, err);
    res.status(500).json({ error: "Failed to build route" });
  }
});

const currentDocuments = {}; // in-memory only: tracks last trip document per car

function getDocumentName(carId, forceNew) {
  // reuse last document unless forced
  if (currentDocuments[carId] && !forceNew) {
    return currentDocuments[carId];
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  const docName = `${carId}_${timestamp}`;
  currentDocuments[carId] = docName;
  console.log(`Created new trip document for ${carId}: ${docName}`);
  return docName;
}

async function logPositionToFirestore(carId, lat, lng, newTrip) {
  const docName = getDocumentName(carId, newTrip);
  const timestamp = new Date().toISOString();
  const collectionRef = firestore.collection("cars_latest_position");

  // Check if this is the first point (new trip)
  const docRef = collectionRef.doc(docName);
  const docSnapshot = await docRef.get();

  if (!docSnapshot.exists) {
    // First point of trip → top-level document
    await docRef.set({
      carId,
      lat,
      lng,
      timestamp,
    });
    console.log(`Logged first point for ${carId} at ${docName}: (${lat}, ${lng})`);
  } else {
    // Subsequent points → subcollection "positions"
    const subDocId = timestamp.replace(/[:.]/g, "");
    const subDocRef = docRef.collection("positions").doc(subDocId);
    await subDocRef.set({
      carId,
      lat,
      lng,
      timestamp,
    });
    console.log(`Logged subsequent point for ${carId} at ${docName}/positions/${subDocId}: (${lat}, ${lng})`);
  }

  return docName;
}

// Unified endpoint
app.post("/carcurpos", async (req, res) => {
  try {
    const { carId, lat, lng, newTrip } = req.body;

    if (!carId || typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "Missing carId, lat, or lng" });
    }

    const docName = await logPositionToFirestore(carId, lat, lng, newTrip);
    res.json({ success: true, carId, document: docName });
  } catch (err) {
    console.error("Firestore log error:", err);
    res.status(500).json({ error: "Firestore write failed" });
  }
});


// helper: get route info from Directions API
async function getDirectionsForPlaces(places) {
  const results = [];

  for (let i = 0; i < places.length - 1; i++) {
    const origin = encodeURIComponent(places[i]);
    const destination = encodeURIComponent(places[i + 1]);
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&key=${DIRECTION_API}`;
    const res = await fetch(url);
    const data = await res.json();

    const leg = data.routes?.[0]?.legs?.[0];
    if (leg?.distance && leg?.duration) {
      results.push({
        from: places[i],
        to: places[i + 1],
        distance: leg.distance.value,
        duration: leg.duration.value,
      });
    } else {
      console.warn(`⚠️ No route for: ${places[i]} → ${places[i + 1]}`);
    }
  }

  // also add the last leg looping back to start
  const lastOrigin = encodeURIComponent(places[places.length - 1]);
  const firstDest = encodeURIComponent(places[0]);
  const loopUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${lastOrigin}&destination=${firstDest}&key=${DIRECTION_API}`;
  const loopRes = await fetch(loopUrl);
  const loopData = await loopRes.json();
  const loopLeg = loopData.routes?.[0]?.legs?.[0];
  if (loopLeg?.distance && loopLeg?.duration) {
    results.push({
      from: places[places.length - 1],
      to: places[0],
      distance: loopLeg.distance.value,
      duration: loopLeg.duration.value,
    });
  }

  return results;
}

// --- New route to start ETA simulation ---
app.post("/startTrip", async (req, res) => {
  try {
    const { carId, startTime } = req.body;
    if (!carId || !startTime)
      return res.status(400).json({ error: "Missing carId or startTime" });

    // --- fetch places from SQLite
    const db = await dbPromise;
    const rows = await db.all(`SELECT name FROM places WHERE car_id = ?`, [carId]);
    const places = rows.map((r) => r.name);

    if (!places.length)
      return res.status(400).json({ error: `No places found for ${carId}` });

    // --- fetch all leg durations/distances once
    const legs = await getDirectionsForPlaces(places);

    const start = new Date(startTime);
    const maxEnd = new Date(start.getTime() + 5 * 60 * 60 * 1000); // +5 hours
    let current = new Date(start);
    let totalDuration = 0;
    const etaTimeline = [];
    let legCounter = 0;

    // --- loop A→B→C→A→B... until +5h reached
    while (current < maxEnd) {
      for (const leg of legs) {
        current = new Date(current.getTime() + leg.duration * 1000);
        totalDuration += leg.duration;

        if (current > maxEnd) break;

        etaTimeline.push({
          ...leg,
          eta: current.toISOString(),
        });
        legCounter++;
      }
    }

    // --- save all to Firestore in ONE collection
    const collectionName = `${carId}_coll_${startTime.replace(/[:T\-Z]/g, "")}`;
    const colRef = firestore.collection(collectionName);

    for (let i = 0; i < etaTimeline.length; i++) {
      await colRef.doc(`leg_${i + 1}`).set(etaTimeline[i]);
    }

    console.log(`✅ ETA timeline (${etaTimeline.length} legs, 5h span) saved to ${collectionName}`);
    res.json({ success: true, totalLegs: etaTimeline.length, collection: collectionName });
  } catch (err) {
    console.error("🔥 /startTrip failed:", err);
    res.status(500).json({ error: "ETA generation failed" });
  }
});

app.get("/listcars", async (req, res) => {
  try {
    const db = await dbPromise;

    // Get all car IDs (union of those in places and videos)
    const carRows = await db.all(`
      SELECT DISTINCT car_id FROM (
        SELECT car_id FROM places
        UNION
        SELECT car_id FROM videos
      )
    `);

    // For each car, fetch its places and video info
    const result = [];
    for (const { car_id } of carRows) {
      const placeRows = await db.all(`SELECT name FROM places WHERE car_id = ?`, [car_id]);
      const videoRow = await db.get(`SELECT filename FROM videos WHERE car_id = ?`, [car_id]);

      result.push({
        id: car_id,
        places: placeRows.map(p => p.name),
        video: videoRow ? videoRow.filename : null
      });
    }

    res.json(result);
  } catch (err) {
    console.error("DB read error:", err);
    res.status(500).json({ error: "DB read failed" });
  }
});

app.post("/addplaces", async (req, res) => {
  try {
    const { carId, places } = req.body;
    if (!carId || !Array.isArray(places) || places.length === 0) {
      return res.status(400).json({ error: "carId and non-empty places[] required" });
    }

    const db = await dbPromise;

    // Insert new places
    const stmt = await db.prepare(`INSERT INTO places (car_id, name) VALUES (?, ?)`);
    for (const place of places) {
      await stmt.run(carId, typeof place === "string" ? place : JSON.stringify(place));
    }
    await stmt.finalize();

    console.log(`📍 Added ${places.length} places to ${carId}`);
    res.json({ success: true, carId, places });
  } catch (err) {
    console.error("🔥 /addplaces error:", err);
    res.status(500).json({ error: "Failed to add or update places" });
  }
});

app.post("/removecar", async (req, res) => {
  try {
    const { carId } = req.body;
    if (!carId) return res.status(400).json({ error: "carId required" });

// --- Firestore cleanup with batches ---
const carsColl = firestore.collection("cars_latest_position");
const allDocs = await carsColl.listDocuments();

let deletedCount = 0;
let batch = firestore.batch();
let batchOps = 0;

// Helper to delete doc and its subcollections recursively using batches
async function deleteDocRecursivelyBatch(docRef) {
  // Delete subcollections first
  const subCollections = await docRef.listCollections();
  for (const subCol of subCollections) {
    const subDocs = await subCol.listDocuments();
    for (const subDoc of subDocs) {
      await deleteDocRecursivelyBatch(subDoc);
    }
  }

  // Add document delete to batch
  batch.delete(docRef);
  deletedCount++;
  batchOps++;

  // Commit if batch reaches 400 ops (safe margin under 500)
  if (batchOps >= 400) {
    await batch.commit();
    console.log(`🔥 Committed batch of ${batchOps} deletions`);
    batch = firestore.batch();
    batchOps = 0;
  }
}

// Loop through main collection docs
for (const docRef of allDocs) {
  if (docRef.id.startsWith(`${carId}_`)) {
    await deleteDocRecursivelyBatch(docRef);
  }
}

// Commit any remaining deletes in the batch
if (batchOps > 0) {
  await batch.commit();
  console.log(`🔥 Committed final batch of ${batchOps} deletions`);
}

console.log(`🔥 Total deleted docs (parents + batches) from cars_latest_position for ${carId}: ${deletedCount}`);

// 2️⃣ Delete any sub-collections
const allCollections = await firestore.listCollections();
let subDeleted = 0;
batch = firestore.batch(); // <== new batch!

for (const col of allCollections) {
  if (col.id.startsWith(`${carId}_`)) {
    const docs = await col.listDocuments();
    for (const doc of docs) {
      batch.delete(doc);
      subDeleted++;
    }
  }
}

if (subDeleted > 0) {
  await batch.commit();
  console.log(`🔥 Deleted ${subDeleted} docs from sub-collections for ${carId}`);
}

console.log(`Firestore cleanup complete for ${carId}`);

    // --- SQLite cleanup ---
    const db = await dbPromise;

    // Delete video file if exists
    const videoRow = await db.get(`SELECT filename FROM videos WHERE car_id = ?`, [carId]);
    if (videoRow && videoRow.filename) {
      const filePath = path.join(process.cwd(), "videos", videoRow.filename);
      try {
        await fs.promises.unlink(filePath);
        console.log(`🗑️ Deleted video file for ${carId}: ${videoRow.filename}`);
      } catch (fileErr) {
        console.warn(`⚠️ Could not delete video file ${filePath}:`, fileErr.message);
      }
    }

    await db.run(`DELETE FROM videos WHERE car_id = ?`, [carId]);
    const result = await db.run(`DELETE FROM places WHERE car_id = ?`, [carId]);
    console.log(` ^=^z Car ${carId} removed — ${result.changes} place rows deleted.`);

    // --- Success response ---
    res.json({ success: true, removed: carId });

  } catch (err) {
    console.error(" ^=^t /removecar error:", err);
    res.status(500).json({ error: "Failed to remove car" });
  }
});


app.get("/stream/:filename", (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(process.cwd(), "videos", filename);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Video not found" });
  }

  // Get video size
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    // --- Handle range requests for streaming ---
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).send("Requested range not satisfiable");
      return;
    }

    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    // --- Serve entire video if no range specified ---
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});


app.listen(PORT, () => console.log(`🚗 Server running on port ${PORT}`));
