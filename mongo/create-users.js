// Creates the "users" collection in the "equity_beans" database, with type validation
// and a unique index on username.
//
// Running it again starts fresh: it drops and recreates the collection.
//
// NOTE ON THE SAMPLE DOCUMENTS BELOW: the passwordHash values are not real hashes, just
// strings shaped like real output so the field's type and format are realistic: bcrypt (what a
// server would write) and pbkdf2-sha256 (what the site's sign-up form writes today, see
// hashPassword() in app.js). No password is ever stored.
const fs = require("fs");

const validator = JSON.parse(fs.readFileSync("mongo/users.validator.json", "utf8"));

db = db.getSiblingDB("equity_beans");

db.users.drop();
db.createCollection("users", {
  validator,
  validationLevel: "strict",
  validationAction: "error",
});

// Login looks an account up by username, and two accounts must never share one, ignoring
// case: "Maria" and "maria" are the same account, as on the site (findUser() in app.js).
// Strength 2 compares letters without case. Queries must pass the same collation to use it.
const CASE_INSENSITIVE = { locale: "en", strength: 2 };
db.users.createIndex({ username: 1 }, { unique: true, collation: CASE_INSENSITIVE });

const PLACEHOLDER_HASH = "$2b$12$PLACEHOLDERplaceholderPLACEHOLDERplaceholderPLACEHOLDERplace";
const PLACEHOLDER_PBKDF2 = "pbkdf2-sha256$600000$PLACEHOLDERsalt==$PLACEHOLDERhashPLACEHOLDERhashPLACEHOLDERha=";

const users = [
  {
    username: "rseneca",
    passwordHash: PLACEHOLDER_HASH,
    role: "customer",
    createdAt: new Date("2026-08-01"),
    lastLoginAt: new Date("2026-09-20"),
  },
  {
    username: "stirimula",
    passwordHash: PLACEHOLDER_HASH,
    role: "customer",
    createdAt: new Date("2026-08-15"),
    lastLoginAt: null,
  },
  {
    username: "sstyles",
    passwordHash: PLACEHOLDER_HASH,
    role: "customer",
    createdAt: new Date("2026-09-01"),
    lastLoginAt: null,
  },
  {
    // Signed up on the site: sign-up logs the customer in, so lastLoginAt starts at createdAt.
    username: "Maria.Lopez",
    passwordHash: PLACEHOLDER_PBKDF2,
    role: "customer",
    createdAt: new Date("2026-10-17T15:04:00Z"),
    lastLoginAt: new Date("2026-10-17T15:04:00Z"),
  },
];

const result = db.users.insertMany(users);
print(`Inserted ${Object.keys(result.insertedIds).length} users into equity_beans.users`);

// ---------- Show that the stored types match the JavaScript types ----------

print("\nStored BSON types for one user:");
printjson(
  db.users
    .aggregate([
      { $match: { username: "rseneca" } },
      {
        $project: {
          _id: { $type: "$_id" }, // objectId
          username: { $type: "$username" }, // string
          passwordHash: { $type: "$passwordHash" }, // string
          createdAt: { $type: "$createdAt" }, // date
          lastLoginAt: { $type: "$lastLoginAt" }, // date
        },
      },
    ])
    .toArray()[0],
);

print("\nAnd for an account that has never logged in (lastLoginAt is null, not missing):");
printjson(
  db.users
    .aggregate([
      { $match: { username: "stirimula" } },
      { $project: { _id: 0, lastLoginAt: { $type: "$lastLoginAt" } } },
    ])
    .toArray()[0],
);

// ---------- Sample queries the website will need later ----------

print("\nLogin lookup, typed in a different case (the collation matches it; passwordHash stays on the server):");
printjson(
  db.users
    .find({ username: "maria.lopez" }, { _id: 0, username: 1, createdAt: 1 })
    .collation(CASE_INSENSITIVE)
    .toArray(),
);

print("\nAccounts that have never logged in:");
printjson(db.users.find({ lastLoginAt: null }, { _id: 0, username: 1 }).toArray());

// ---------- Show that the validator and the index reject bad data ----------

print("\nTrying to insert a user with a plain-text password field (should be rejected):");
try {
  db.users.insertOne({ username: "badactor", password: "hunter2", createdAt: new Date() });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to put a plain-text password in passwordHash (should be rejected by its pattern):");
try {
  db.users.insertOne({ username: "plaintext", passwordHash: "hunter2", createdAt: new Date() });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}

print("\nTrying to insert a duplicate username (should be rejected by the unique index):");
try {
  db.users.insertOne({
    username: "rseneca",
    passwordHash: PLACEHOLDER_HASH,
    role: "customer",
    createdAt: new Date(),
  });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.code === 11000 ? "Duplicate key" : err.message}`);
}

print("\nTrying the same username in different case, RSeneca (should also be rejected):");
try {
  db.users.insertOne({
    username: "RSeneca",
    passwordHash: PLACEHOLDER_HASH,
    role: "customer",
    createdAt: new Date(),
  });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.code === 11000 ? "Duplicate key (case-insensitive index)" : err.message}`);
}

print("\nTrying to insert createdAt as an ISO string instead of a BSON date (should be rejected):");
try {
  db.users.insertOne({
    username: "stringdate",
    passwordHash: PLACEHOLDER_HASH,
    role: "customer",
    createdAt: new Date().toISOString(),
  });
  print("  Unexpected: the document was accepted.");
} catch (err) {
  print(`  Rejected as expected: ${err.errInfo ? "Document failed validation" : err.message}`);
}
