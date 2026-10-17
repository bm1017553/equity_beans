// Creates the "orders" collection in the "equity_beans" database, with type validation,
// a unique index on orderId, and two sample orders.
//
// Run from the project folder:
//   mongosh "<your connection string>" mongo/create-orders.js
// e.g. local:  mongosh "mongodb://localhost:27017" mongo/create-orders.js
//
// Running it again starts fresh: it drops and recreates the collection.
//
// The sample documents below match the order object built in checkout.html, with one
// conversion the API will also have to make (see SCHEMA.md): createdAt becomes a BSON date,
// not an ISO string.
const fs = require("fs");

const validator = JSON.parse(fs.readFileSync("mongo/orders.validator.json", "utf8"));

db = db.getSiblingDB("equity_beans");

db.orders.drop();
db.createCollection("orders", {
  validator,
  validationLevel: "strict",
  validationAction: "error",
});

// The confirmation screen and any "look up my order" feature use this number.
db.orders.createIndex({ orderId: 1 }, { unique: true });
// An account's order history, newest first.
db.orders.createIndex({ userId: 1, createdAt: -1 });
// Fulfillment queue: everything not yet shipped.
db.orders.createIndex({ status: 1, createdAt: 1 });

// Helper: build the money fields the same way the site does, so they can't disagree.
// amountCents is rounded from the dollar total exactly as checkout.html does.
function withTotals(order, subtotal, shipping) {
  const total = subtotal + shipping;
  return {
    ...order,
    totals: { subtotal, shipping, total },
    amountCents: Math.round(total * 100),
  };
}

const orders = [
  withTotals(
    {
      orderId: "EB-M2X4K9A1",
      userId: null, // guest checkout
      customer: {
        name: "Renee Seneca",
        email: "renee.seneca@example.com",
        address: "1402 Pinecrest Ave",
        city: "Amarillo",
        state: "TX",
        zip: "79109",
      },
      items: [
        {
          productId: "1001",
          name: "Aprysa Peruvian Coffee",
          option: "Ground & Roasted",
          unitPrice: 50,
          qty: 2,
        },
      ],
      status: "paid",
      createdAt: new Date("2026-09-18T15:42:00Z"),
    },
    100, // subtotal: 2 x 50 (regular price; this option is not on sale)
    0, // free shipping: subtotal reaches FREE_SHIPPING_MIN (100) exactly
  ),
  withTotals(
    {
      orderId: "EB-M31Q7BZ5",
      userId: null,
      customer: {
        name: "Sean Styles",
        email: "sstyles@example.com",
        address: "88 Harbor St Apt 4C",
        city: "Portland",
        state: "OR",
        zip: "97204",
      },
      items: [
        {
          productId: "1003",
          name: "Cerrado Brazilian Coffee",
          option: "Ground & Roasted",
          unitPrice: 38,
          qty: 1,
        },
      ],
      status: "pending_payment",
      createdAt: new Date("2026-10-02T19:05:00Z"),
    },
    38, // subtotal: 1 x 38, the sale price (regular 42) — unitPrice stores what was charged
    5, // SHIPPING_FEE: under the free-shipping minimum
  ),
];

const result = db.orders.insertMany(orders);
print(`Inserted ${Object.keys(result.insertedIds).length} orders into equity_beans.orders`);

// ---------- Show that the stored types match the JavaScript types ----------

print("\nStored BSON types for one order (EB-M2X4K9A1):");
printjson(
  db.orders
    .aggregate([
      { $match: { orderId: "EB-M2X4K9A1" } },
      {
        $project: {
          _id: 0,
          orderId: { $type: "$orderId" }, // string
          userId: { $type: "$userId" }, // null (guest)
          customerEmail: { $type: "$customer.email" }, // string
          customerZip: { $type: "$customer.zip" }, // string (keeps leading zeros)
          firstItemQty: { $type: { $arrayElemAt: ["$items.qty", 0] } }, // int
          firstItemUnitPrice: { $type: { $arrayElemAt: ["$items.unitPrice", 0] } }, // number
          totalsTotal: { $type: "$totals.total" }, // number (dollars)
          amountCents: { $type: "$amountCents" }, // int (cents, for Square)
          status: { $type: "$status" }, // string
          createdAt: { $type: "$createdAt" }, // date
        },
      },
    ])
    .toArray()[0],
);

// ---------- Sample queries the website will need later ----------

print("\nOrders still awaiting payment:");
printjson(
  db.orders.find({ status: "pending_payment" }, { _id: 0, orderId: 1, amountCents: 1 }).toArray(),
);

print("\nRevenue by status (dollars from totals, cents from amountCents):");
printjson(
  db.orders
    .aggregate([
      {
        $group: {
          _id: "$status",
          orders: { $sum: 1 },
          dollars: { $sum: "$totals.total" },
          cents: { $sum: "$amountCents" },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray(),
);

print("\nUnits sold per product (what a 'best sellers' row would use):");
printjson(
  db.orders
    .aggregate([
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          name: { $first: "$items.name" },
          units: { $sum: "$items.qty" },
        },
      },
      { $sort: { units: -1 } },
    ])
    .toArray(),
);

// Because createdAt is a real BSON date, date math works. It would not on an ISO string.
print("\nOrders per month ($dateTrunc only works because createdAt is a BSON date):");
printjson(
  db.orders
    .aggregate([
      {
        $group: { _id: { $dateTrunc: { date: "$createdAt", unit: "month" } }, orders: { $sum: 1 } },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray(),
);

// ---------- Show that the validator rejects the wrong types ----------

print("\nTrying to insert an order with createdAt as an ISO string (should be rejected):");
try {
  db.orders.insertOne({ ...orders[0], orderId: "EB-BADDATE", createdAt: new Date().toISOString() });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert an order with a fractional quantity of 1.5 (should be rejected):");
try {
  const bad = { ...orders[0], orderId: "EB-BADQTY", items: [{ ...orders[0].items[0], qty: 1.5 }] };
  db.orders.insertOne(bad);
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert an order with an unknown status (should be rejected):");
try {
  db.orders.insertOne({ ...orders[0], orderId: "EB-BADSTAT", status: "refunded" });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print(
  "\nTrying to insert a ZIP code as a number, which would drop leading zeros (should be rejected):",
);
try {
  const bad = {
    ...orders[0],
    orderId: "EB-BADZIP",
    customer: { ...orders[0].customer, zip: 79109 },
  };
  db.orders.insertOne(bad);
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}
