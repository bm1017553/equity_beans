// Creates the "messages" collection in the "equity_beans" database, with type validation,
// indexes, and three sample messages from the contact page.
//
// Run from the project folder:
//   mongosh "<your connection string>" mongo/create-messages.js
// e.g. local:  mongosh "mongodb://localhost:27017" mongo/create-messages.js
//
// Running it again starts fresh: it drops and recreates the collection.
//
// The sample documents below match the message object built in contact.html, with the
// conversions the API will also have to make (see SCHEMA.md): createdAt becomes a BSON date, and
// the browser's username becomes userId.
const fs = require("fs");

const validator = JSON.parse(fs.readFileSync("mongo/messages.validator.json", "utf8"));

db = db.getSiblingDB("equity_beans");

db.messages.drop();
db.createCollection("messages", {
  validator,
  validationLevel: "strict",
  validationAction: "error",
});

// Support inbox: new messages first, newest first.
db.messages.createIndex({ status: 1, createdAt: -1 });
// One customer's messages, newest first.
db.messages.createIndex({ userId: 1, createdAt: -1 });

const messages = [
  {
    // A guest asking about the coffee itself.
    userId: null,
    name: "Avery Cole",
    email: "avery.cole@example.com",
    topic: "coffee",
    orderId: null,
    message: "Which of your coffees would you suggest for cold brew? I like chocolatey flavors.",
    status: "new",
    createdAt: new Date("2026-10-14T16:20:00Z"),
  },
  {
    // An order question that references a sample order from create-orders.js by its number.
    userId: null,
    name: "Renee Seneca",
    email: "renee.seneca@example.com",
    topic: "order",
    orderId: "EB-M2X4K9A1",
    message: "Can I switch my Aprysa order from ground to whole bean before it ships?",
    status: "answered",
    createdAt: new Date("2026-09-18T18:05:00Z"),
  },
  {
    userId: null,
    name: "Sean Styles",
    email: "sean.styles@example.com",
    topic: "feedback",
    orderId: null,
    message: "The coffee quiz picked the Guji for me and it's my new favorite. Thanks!",
    status: "closed",
    createdAt: new Date("2026-10-10T09:45:00Z"),
  },
];

const result = db.messages.insertMany(messages);
print(`Inserted ${Object.keys(result.insertedIds).length} messages into equity_beans.messages`);

// ---------- Show that the stored types match the JavaScript types ----------

print("\nStored BSON types for one message (the order question):");
printjson(
  db.messages
    .aggregate([
      { $match: { orderId: "EB-M2X4K9A1" } },
      {
        $project: {
          _id: 0,
          userId: { $type: "$userId" }, // null (sent by a guest)
          email: { $type: "$email" }, // string
          topic: { $type: "$topic" }, // string, one of five
          orderId: { $type: "$orderId" }, // string (null on the others)
          status: { $type: "$status" }, // string, one of three
          createdAt: { $type: "$createdAt" }, // date
        },
      },
    ])
    .toArray()[0],
);

// ---------- Sample queries the website will need later ----------

print("\nSupport inbox: messages not answered yet, newest first:");
printjson(
  db.messages
    .find({ status: "new" }, { _id: 0, name: 1, topic: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .toArray(),
);

print("\nMessages per topic:");
printjson(
  db.messages.aggregate([{ $group: { _id: "$topic", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
);

// ---------- Show that the validator rejects bad data ----------

// insertMany added an _id to each sample; copy one without it, so only the field under test is wrong.
function sampleWithout_id(i) {
  const { _id, ...rest } = messages[i];
  return rest;
}

print("\nTrying to insert a message with an invalid email (should be rejected):");
try {
  db.messages.insertOne({ ...sampleWithout_id(0), email: "not-an-email" });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert a message with a topic the form doesn't offer (should be rejected):");
try {
  db.messages.insertOne({ ...sampleWithout_id(0), topic: "wholesale" });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert a message longer than 1000 characters (should be rejected):");
try {
  db.messages.insertOne({ ...sampleWithout_id(0), message: "x".repeat(1001) });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert an order number in the wrong format (should be rejected):");
try {
  db.messages.insertOne({ ...sampleWithout_id(1), orderId: "12345" });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}
