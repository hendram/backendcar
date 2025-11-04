const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { BigQuery } = require("@google-cloud/bigquery");

admin.initializeApp();
const db = admin.firestore();
const bigquery = new BigQuery();

exports.syncCar1CollectionToBQ = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
  const datasetId = "firestore_export"; // your BQ dataset
  const tableId = "car1collection";      // test table

  const snapshot = await db.collection("car1collection").get();
  if (snapshot.empty) {
    console.log("No documents found");
    return null;
  }

  const rows = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  await bigquery.dataset(datasetId).table(tableId).insert(rows);
  console.log(`Inserted ${rows.length} rows to BigQuery`);
});
