// Creates the "products" collection in the "equity_beans" database, with type validation,
// a unique index, and the website's coffees as sample documents.
//
// Run from the project folder (so the relative paths below resolve):
//   mongosh "<your connection string>" mongo/create-products.js
// e.g. local:  mongosh "mongodb://localhost:27017" mongo/create-products.js
//
// Running it again starts fresh: it drops and recreates the collection.
const fs = require("fs");

const products = JSON.parse(fs.readFileSync("data/products.json", "utf8"));
const validator = JSON.parse(fs.readFileSync("mongo/products.validator.json", "utf8"));

db = db.getSiblingDB("equity_beans");

db.products.drop();
db.createCollection("products", {
  validator,
  validationLevel: "strict", // check every insert and update
  validationAction: "error", // reject documents that don't match
});

// The website looks coffees up by this key (product.html?id=...), so it must be unique.
db.products.createIndex({ id: 1 }, { unique: true });

const result = db.products.insertMany(products);
print(`Inserted ${Object.keys(result.insertedIds).length} products into equity_beans.products`);

// ---------- Show that the stored types match the JavaScript types ----------

print("\nStored BSON types for one document (1003, Cerrado Brazilian):");
printjson(
  db.products
    .aggregate([
      { $match: { id: "1003" } },
      {
        $project: {
          _id: 0,
          name: { $type: "$name" }, // string
          inStock: { $type: "$inStock" }, // bool
          flavors: { $type: "$flavors" }, // array
          firstOptionPrice: { $type: { $arrayElemAt: ["$options.price", 0] } }, // number
          firstOptionSalePrice: { $type: { $arrayElemAt: ["$options.salePrice", 0] } }, // number (on sale)
          secondOptionSalePrice: { $type: { $arrayElemAt: ["$options.salePrice", 1] } }, // null (not on sale)
          firstOptionAvailable: { $type: { $arrayElemAt: ["$options.available", 0] } }, // bool
        },
      },
    ])
    .toArray()[0]
);

// ---------- Sample queries the website will need later ----------

print("\nOut of stock (inStock: false):");
printjson(db.products.find({ inStock: false }, { _id: 0, id: 1, name: 1 }).toArray());

print("\nOptions on sale (salePrice is a number, not null):");
printjson(
  db.products
    .aggregate([
      { $unwind: "$options" },
      { $match: { "options.salePrice": { $type: "number" } } },
      { $project: { _id: 0, name: 1, option: "$options.name", price: "$options.price", salePrice: "$options.salePrice" } },
    ])
    .toArray()
);

// ---------- Show that the validator rejects the wrong types ----------

print("\nTrying to insert a product with a price stored as a string (should be rejected):");
try {
  const bad = { ...products[0], id: "9999", options: [{ ...products[0].options[0], price: "50.00" }] };
  db.products.insertOne(bad);
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}
