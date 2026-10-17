// Creates the "reviews" collection in the "equity_beans" database, with type validation,
// indexes, and the website's seed reviews as sample documents.
//
// Run from the project folder (so the relative paths below resolve):
//   mongosh "<your connection string>" mongo/create-reviews.js
// e.g. local:  mongosh "mongodb://localhost:27017" mongo/create-reviews.js
//
// Running it again starts fresh: it drops and recreates the collection.
const fs = require("fs");

const seedReviews = JSON.parse(fs.readFileSync("data/reviews.json", "utf8"));
const validator = JSON.parse(fs.readFileSync("mongo/reviews.validator.json", "utf8"));

db = db.getSiblingDB("equity_beans");

db.reviews.drop();
db.createCollection("reviews", {
  validator,
  validationLevel: "strict", // check every insert and update
  validationAction: "error", // reject documents that don't match
});

// Every page that shows reviews looks them up by product, so index that key. Not unique:
// one coffee has many reviews.
db.reviews.createIndex({ productId: 1 });
// The reviews page sorts newest first within a product.
db.reviews.createIndex({ productId: 1, date: -1 });
// The account page lists a customer's own reviews, newest first.
db.reviews.createIndex({ userId: 1, date: -1 });

// mongosh stores a whole JavaScript number like 5 as BSON int, which the validator requires.
const reviews = seedReviews;

const result = db.reviews.insertMany(reviews);
print(`Inserted ${Object.keys(result.insertedIds).length} reviews into equity_beans.reviews`);

// ---------- Show that the stored types match the JavaScript types ----------

print("\nStored BSON types for one review:");
printjson(
  db.reviews
    .aggregate([
      { $match: { productId: "1001" } },
      { $limit: 1 },
      {
        $project: {
          _id: 0,
          productId: { $type: "$productId" }, // string
          userId: { $type: "$userId" }, // null (a seed review; an account's review stores an objectId)
          name: { $type: "$name" }, // string
          rating: { $type: "$rating" }, // int
          comment: { $type: "$comment" }, // string
          date: { $type: "$date" }, // string (YYYY-MM-DD, not a BSON date)
        },
      },
    ])
    .toArray()[0],
);

// ---------- Sample queries the website will need later ----------

print("\nReviews for product 1001, newest first:");
printjson(
  db.reviews
    .find({ productId: "1001" }, { _id: 0, name: 1, rating: 1, date: 1 })
    .sort({ date: -1 })
    .toArray(),
);

print("\nReviews not written by an account (userId: null, here the three seed reviews):");
printjson(db.reviews.countDocuments({ userId: null }));

print("\nAverage rating per product (what averageRating() does in app.js):");
printjson(
  db.reviews
    .aggregate([
      {
        $group: { _id: "$productId", averageRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray(),
);

// ---------- Show that the validator rejects the wrong types ----------

print("\nTrying to insert a review with a half-star rating of 4.5 (should be rejected):");
try {
  db.reviews.insertOne({ ...reviews[0], rating: 4.5 });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert a review with no userId at all (should be rejected: use null for no account):");
try {
  const { userId, ...withoutUserId } = reviews[0];
  db.reviews.insertOne(withoutUserId);
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print(
  "\nTrying to insert a review with date as a BSON date instead of YYYY-MM-DD (should be rejected):",
);
try {
  db.reviews.insertOne({ ...reviews[0], date: new Date() });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}
