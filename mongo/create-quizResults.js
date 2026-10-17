// Creates the "quizResults" collection in the "equity_beans" database, with type validation
// and sample results.
//
// Run from the project folder:
//   mongosh "<your connection string>" mongo/create-quizResults.js
// e.g. local:  mongosh "mongodb://localhost:27017" mongo/create-quizResults.js
//
// Running it again starts fresh: it drops and recreates the collection.
//
// One conversion to note (see SCHEMA.md): saveQuizResult() in app.js writes takenAt as an ISO
// string, but this collection stores a real BSON date, so the API must convert on insert.
const fs = require("fs");

const validator = JSON.parse(fs.readFileSync("mongo/quizResults.validator.json", "utf8"));

db = db.getSiblingDB("equity_beans");

db.quizResults.drop();
db.createCollection("quizResults", {
  validator,
  validationLevel: "strict",
  validationAction: "error",
});

// The shop sidebar shows a logged-in customer their latest result.
db.quizResults.createIndex({ userId: 1, takenAt: -1 });

const quizResults = [
  { userId: null, productIds: ["1001", "1004", "1006"], takenAt: new Date("2026-09-12T14:20:00Z") },
  { userId: null, productIds: ["1003", "1001"], takenAt: new Date("2026-09-29T09:05:00Z") },
  // Only in-stock coffees appear: the quiz never recommends inStock: false (1011 Kasama Zambian).
  {
    userId: null,
    productIds: ["1007", "1009", "1008", "1002"],
    takenAt: new Date("2026-10-05T17:48:00Z"),
  },
];

const result = db.quizResults.insertMany(quizResults);
print(
  `Inserted ${Object.keys(result.insertedIds).length} quiz results into equity_beans.quizResults`,
);

// ---------- Show that the stored types match the JavaScript types ----------

print("\nStored BSON types for one quiz result:");
printjson(
  db.quizResults
    .aggregate([
      { $match: { productIds: "1001" } },
      { $limit: 1 },
      {
        $project: {
          _id: 0,
          userId: { $type: "$userId" }, // null (taken while logged out)
          productIds: { $type: "$productIds" }, // array
          firstProductId: { $type: { $arrayElemAt: ["$productIds", 0] } }, // string
          takenAt: { $type: "$takenAt" }, // date
        },
      },
    ])
    .toArray()[0],
);

// ---------- Sample queries the website will need later ----------

print("\nMost recent result (what the shop sidebar reads):");
printjson(
  db.quizResults
    .find({}, { _id: 0, productIds: 1, takenAt: 1 })
    .sort({ takenAt: -1 })
    .limit(1)
    .toArray(),
);

print("\nHow often each coffee comes up as a match:");
printjson(
  db.quizResults
    .aggregate([
      { $unwind: "$productIds" },
      { $group: { _id: "$productIds", timesMatched: { $sum: 1 } } },
      { $sort: { timesMatched: -1, _id: 1 } },
    ])
    .toArray(),
);

print("\nHow often each coffee was the top match (array order is meaningful):");
printjson(
  db.quizResults
    .aggregate([
      { $project: { topMatch: { $arrayElemAt: ["$productIds", 0] } } },
      { $group: { _id: "$topMatch", timesTopMatch: { $sum: 1 } } },
      { $sort: { timesTopMatch: -1, _id: 1 } },
    ])
    .toArray(),
);

// ---------- Show that the validator rejects the wrong types ----------

print("\nTrying to insert a result with takenAt as an ISO string (should be rejected):");
try {
  db.quizResults.insertOne({
    userId: null,
    productIds: ["1001"],
    takenAt: new Date().toISOString(),
  });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print(
  "\nTrying to insert productIds as numbers instead of four-digit strings (should be rejected):",
);
try {
  db.quizResults.insertOne({ userId: null, productIds: [1001, 1004], takenAt: new Date() });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert an empty productIds array (should be rejected):");
try {
  db.quizResults.insertOne({ userId: null, productIds: [], takenAt: new Date() });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}
