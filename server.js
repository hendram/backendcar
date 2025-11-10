import express from "express";
import dotenv from "dotenv";
import allowAllCors from "./corsConfig.js";
import polyline from "@mapbox/polyline";
import fetch from "node-fetch";
import fs from "fs"; 
import path from "path";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(allowAllCors);
app.use(express.json());

let credential = admin.credential.applicationDefault();
admin.initializeApp({ credential });

const firestore = admin.firestore();
const DIRECTION_API = process.env.DIRECTION_API;
import videoRoutes from "./routes/video.js";
app.use("/video", videoRoutes);

function getBucket() {
  return admin.storage().bucket(process.env.GCS_BUCKET_NAME);
}
 

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

app.get("/getcarroute", async (req, res) => {
  const carId = req.query.carId;
  if (!carId) return res.status(400).json({ error: "carId required" });

  try {
    const placesDoc = await firestore.collection(carId).doc("places").get();
    if (!placesDoc.exists) {
      return res.status(404).json({ error: "No places found for this car" });
    }

    const places = placesDoc.data().names || [];
    if (places.length === 0)
      return res.status(404).json({ error: "No places found for this car" });

    const segmentPromises = [];
    for (let i = 0; i < places.length; i++) {
      const start = places[i];
      const end = places[(i + 1) % places.length]; 
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

const currentDocuments = {}; 

function getDocumentName(carId, forceNew) {
  if (currentDocuments[carId] && !forceNew) {
    return currentDocuments[carId];
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  const docName = `${carId}_${timestamp}`;
  currentDocuments[carId] = docName;
  return docName;
}

async function logPositionToFirestore(carId, lat, lng, newTrip) {
  const docName = getDocumentName(carId, newTrip);
  const timestamp = new Date().toISOString();
  const collectionRef = firestore.collection("cars_latest_position");

  const docRef = collectionRef.doc(docName);
  const docSnapshot = await docRef.get();

  if (!docSnapshot.exists) {
    await docRef.set({
      carId,
      lat,
      lng,
      timestamp,
    });
  } else {
    const subDocId = timestamp.replace(/[:.]/g, "");
    const subDocRef = docRef.collection("positions").doc(subDocId);
    await subDocRef.set({
      carId,
      lat,
      lng,
      timestamp,
    });
  }

  return docName;
}

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

app.post("/startTrip", async (req, res) => {
  try {
    const { carId, startTime } = req.body;
    if (!carId || !startTime)
      return res.status(400).json({ error: "Missing carId or startTime" });

    const placesDoc = await firestore.collection(carId).doc("places").get();
    if (!placesDoc.exists) {
      return res.status(400).json({ error: `No places found for ${carId}` });
    }

    const places = placesDoc.data().names || [];
    if (!places.length)
      return res.status(400).json({ error: `No places found for ${carId}` });

    const legs = await getDirectionsForPlaces(places);

    const start = new Date(startTime);
    const maxEnd = new Date(start.getTime() + 5 * 60 * 60 * 1000);
    let current = new Date(start);
    let totalDuration = 0;
    const etaTimeline = [];
    let legCounter = 0;

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

    const collectionName = `${carId}_coll_${startTime.replace(/[:T\-Z]/g, "")}`;
    const colRef = firestore.collection(collectionName);

    for (let i = 0; i < etaTimeline.length; i++) {
      await colRef.doc(`leg_${i + 1}`).set(etaTimeline[i]);
    }

    res.json({ success: true, totalLegs: etaTimeline.length, collection: collectionName });
  } catch (err) {
    console.error("🔥 /startTrip failed:", err);
    res.status(500).json({ error: "ETA generation failed" });
  }
});

app.get("/listcars", async (req, res) => {
  try {
    const collections = await firestore.listCollections();

    const result = [];

    const carIdPattern = /^car\d+$/;

    for (const col of collections) {
      const colName = col.id;

      if (!carIdPattern.test(colName)) {
        continue;
      }

      const placesDoc = await col.doc("places").get();
      const videoDoc = await col.doc("video").get();

      const places = placesDoc.exists ? placesDoc.data().names || [] : [];
      const video = videoDoc.exists ? videoDoc.data().filename : null;


      result.push({
        id: colName,
        places,
        video,
      });
    }

    res.json(result);
  } catch (err) {
    console.error("🔥 [listcars] Firestore read error:", err);
    res.status(500).json({ error: "Firestore read failed" });
  }
});


app.post("/addplaces", async (req, res) => {
  try {
    const { carId, places } = req.body;
    if (!carId || !Array.isArray(places) || places.length === 0) {
      return res.status(400).json({ error: "carId and non-empty places[] required" });
    }

    await firestore.collection(carId).doc("places").set({ names: places });

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


    const videoDocRef = firestore.collection(carId).doc("video");
   const videoDoc = await videoDocRef.get();

    if (videoDoc.exists) {
      const { filename } = videoDoc.data() || {};
      if (filename) {
        const bucket = getBucket();
        const file = bucket.file(filename);
                 
        try {
          await file.delete();
        } catch (gcsErr) {
          if (gcsErr.code === 404 || /Not Found/i.test(String(gcsErr.message))) {
            console.warn(`⚠️ File not found in GCS (or already deleted): ${filename}`);
          } else {
            console.warn(`⚠️ Error deleting file from GCS: ${filename}`, gcsErr);
          }
        }
      } else {
        console.log("ℹ️ video doc exists but has no filename field");
      }
    } else {
      console.log("ℹ️ No video doc found for this car");
    }


    const collectionRef = firestore.collection(carId);
    const docs = await collectionRef.listDocuments();

    if (docs.length === 0) {
      console.log("ℹ️ No documents to delete in collection");
    } else {
      let batch = firestore.batch();
      let count = 0;
      const BATCH_SIZE = 500; 
      for (const docRef of docs) {
        batch.delete(docRef);
        count++;

        if (count >= BATCH_SIZE) {
          await batch.commit();
          batch = firestore.batch();
          count = 0;
        }
      }

      if (count > 0) {
        await batch.commit();
      }
    }

    console.log(`🏁 Finished removing car collection and GCS file (if any): ${carId}`);
    return res.json({ success: true, removed: carId });
  } catch (err) {
    console.error("🔥 /removecar error:", err);
    return res.status(500).json({ error: "Failed to remove car" });
  }
});

app.get("/stream/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const bucket = getBucket();
    const file = bucket.file(filename);

    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: "Video not found" });

    const [metadata] = await file.getMetadata();
    const fileSize = parseInt(metadata.size, 10);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize) {
        res.status(416).send("Requested range not satisfiable");
        return;
      }

      const chunkSize = end - start + 1;
      const stream = file.createReadStream({ start, end });
      const head = {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": metadata.contentType,
      };
      res.writeHead(206, head);
      stream.pipe(res);
    } else {
      const stream = file.createReadStream();
      const head = {
        "Content-Length": fileSize,
        "Content-Type": metadata.contentType,
      };
      res.writeHead(200, head);
      stream.pipe(res);
    }
  } catch (err) {
    console.error("🔥 /stream/:filename error:", err);
    res.status(500).json({ error: "Stream failed" });
  }
});


app.listen(PORT, () => console.log(`🚗 Server running on port ${PORT}`));
