// Equity Beans server: serves the site's pages and a JSON API over the equity_beans database.
// Start it with `npm start`, then open http://localhost:3000. See mongo/SCHEMA.md.
//
// The API speaks the same shapes the pages already use (`username`, ISO date strings) and
// makes the conversions SCHEMA.md lists at the boundary: `username` -> `userId`, ISO strings
// -> BSON dates. `userId`, `passwordHash` and security answer hashes never leave the server, and
// `_id` only does on the admin routes (a contact message's id).

const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const express = require("express");
const session = require("express-session");
const typeis = require("type-is");
const { MongoStore } = require("connect-mongo");
const { MongoClient, ObjectId } = require("mongodb");

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = "equity_beans";
const ROOT = __dirname;

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET is not set (see .env.example); everyone is logged out when the server restarts.");
}

// Same rules as app.js and the validators in mongo/.
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;
const PBKDF2_ITERATIONS = 600000; // OWASP's recommendation for PBKDF2-SHA256
const MAX_QTY = 10;
const SHIPPING_FEE = 5.0;
const FREE_SHIPPING_MIN = 100.0;
const PRODUCT_ID_PATTERN = /^[0-9]{4}$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ORDER_ID_PATTERN = /^EB-[A-Z0-9]+$/;
// Security questions for resetting a forgotten password. Accounts store the id, so the wording
// can change without breaking anyone's answers. Same ids as mongo/users.validator.json.
// Chosen so the answers are stable and hard to find online (no "mother's maiden name").
const SECURITY_QUESTIONS = {
  "first-pet": "What was the name of your first pet?",
  "childhood-street": "What street did you live on as a child?",
  "first-concert": "What was the first concert you went to?",
  "childhood-friend": "What was your childhood best friend’s first name?",
  "first-car": "What was the make and model of your first car?",
  "favorite-teacher": "What was the last name of your favorite teacher?",
  "first-job": "Where was your first job?",
  "parents-met": "In what city did your parents meet?",
};
const QUESTIONS_PER_ACCOUNT = 2;
const MIN_ANSWER_LENGTH = 2;
const MAX_ANSWER_LENGTH = 100;
// Usernames are unique ignoring case; queries must pass this to use the users index.
const CASE_INSENSITIVE = { locale: "en", strength: 2 };
const SESSION_DAYS = 30;
// The statuses the admin page can set: the same enums as mongo/orders.validator.json and
// mongo/messages.validator.json.
const ORDER_STATUSES = ["pending_payment", "paid", "shipped", "cancelled"];
const MESSAGE_STATUSES = ["new", "answered", "closed"];

const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);

// ---------- Passwords ----------

// "pbkdf2-sha256$<iterations>$<salt>$<hash>", the format app.js used to write in the browser,
// so the users validator and any existing hashes stay valid. Node's built-in crypto avoids
// native modules (bcrypt, argon2) that have to be compiled for this machine.
const pbkdf2 = promisify(crypto.pbkdf2);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password, passwordHash) {
  const [scheme, iterations, salt, expected] = passwordHash.split("$");
  if (scheme !== "pbkdf2-sha256" || !salt || !expected) return false;
  const expectedBytes = Buffer.from(expected, "base64");
  const actual = await pbkdf2(password, Buffer.from(salt, "base64"), Number(iterations), expectedBytes.length || 32, "sha256");
  return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
}

// Checked against when the username doesn't exist, so a wrong username takes as long as a
// wrong password and the response time doesn't reveal which usernames are taken.
const dummyHash = hashPassword(crypto.randomBytes(16).toString("hex"));

// ---------- Security questions ----------

// "Fluffy", " fluffy" and "FLUFFY  " are the same answer: compared ignoring capitals, extra
// spaces, and the different ways a keyboard can type the same accented letter (NFKC).
function normalizeAnswer(value) {
  return text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

// Answers are hashed exactly like passwords. They're short and guessable, so a slow hash
// matters even more: a stolen database shouldn't give them away.
function hashAnswer(answer) {
  return hashPassword(normalizeAnswer(answer));
}

// Checks the questions sent from sign-up or the account page:
// [{ questionId, answer }, { questionId, answer }]. Returns them ready to store, or throws.
async function securityQuestionsFrom(value) {
  const items = Array.isArray(value) ? value : [];
  const ids = items.map((item) => item && item.questionId);
  if (items.length !== QUESTIONS_PER_ACCOUNT || !ids.every((id) => Object.hasOwn(SECURITY_QUESTIONS, id))) {
    throw clientError(400, `Please choose ${QUESTIONS_PER_ACCOUNT} security questions.`);
  }
  if (new Set(ids).size !== ids.length) throw clientError(400, "Please choose two different security questions.");
  for (const item of items) {
    const length = normalizeAnswer(item.answer).length;
    if (length < MIN_ANSWER_LENGTH || length > MAX_ANSWER_LENGTH) {
      throw clientError(400, `Security answers need ${MIN_ANSWER_LENGTH} to ${MAX_ANSWER_LENGTH} characters.`);
    }
  }
  return Promise.all(items.map(async (item) => ({ questionId: item.questionId, answerHash: await hashAnswer(item.answer) })));
}

// For a username with no account (or no questions), the reset form still shows two questions,
// picked from the username with the session secret, so they're the same every time and look
// like a real account's. The form never says which usernames exist.
function decoyQuestionIds(username) {
  const ids = Object.keys(SECURITY_QUESTIONS);
  const digest = crypto.createHmac("sha256", SESSION_SECRET).update(username.toLowerCase()).digest();
  const first = digest[0] % ids.length;
  const second = (first + 1 + (digest[1] % (ids.length - 1))) % ids.length;
  return [ids[first], ids[second]];
}

// ---------- Lockouts ----------

// Wrong passwords and wrong security answers are counted per account, and too many in a row
// lock that action for a while, so nobody can keep guessing. Each kind has its own fields on the
// users document, so a locked login doesn't block a reset and the other way round.
const LOCKS = {
  login: { failures: "loginFailures", lockedUntil: "loginLockedUntil", max: 10, minutes: 15 },
  reset: { failures: "resetFailures", lockedUntil: "resetLockedUntil", max: 5, minutes: 60 },
};

// When the lock ends, or null when `kind` isn't locked for this account.
function lockedUntil(user, kind) {
  const until = user && user[LOCKS[kind].lockedUntil];
  return until > new Date() ? until : null;
}

// Counts one failure, atomically, so guesses sent at the same moment can't slip past the limit.
// Returns when the lock ends if this failure locked the account, otherwise null.
async function recordFailure(user, kind) {
  const { failures, lockedUntil: field, max, minutes } = LOCKS[kind];
  const users = db.collection("users");
  const updated = await users.findOneAndUpdate({ _id: user._id }, { $inc: { [failures]: 1 } }, { returnDocument: "after" });
  if (updated[failures] < max) return null;
  const until = new Date(Date.now() + minutes * 60 * 1000);
  await users.updateOne({ _id: user._id }, { $set: { [field]: until, [failures]: 0 } });
  return until;
}

// The update that clears a kind of lock and its count, for withUpdates().
function clearLock(kind) {
  return { $set: { [LOCKS[kind].failures]: 0 }, $unset: { [LOCKS[kind].lockedUntil]: "" } };
}

// Merges updates like { $set }, { $unset } into one, for a single updateOne.
function withUpdates(...updates) {
  const merged = {};
  for (const update of updates) {
    for (const [operator, fields] of Object.entries(update)) merged[operator] = { ...merged[operator], ...fields };
  }
  return merged;
}

function minutesLeft(until) {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return `${minutes} more minute${minutes === 1 ? "" : "s"}`;
}

function loginLockedError(until) {
  return clientError(
    429,
    `Too many wrong passwords. Logging in to this account is locked for ${minutesLeft(until)}. You can reset your password with your security questions to get in sooner.`
  );
}

function resetLockedError(until) {
  return clientError(429, `Too many wrong answers. Password reset for this account is locked for ${minutesLeft(until)}. You can still log in with your password.`);
}

// Checks the current password on the account page (changing the password or security
// questions). Wrong guesses count toward the login lock, so a borrowed logged-in browser can't
// be used to guess the password either.
async function checkCurrentPassword(user, password) {
  const locked = lockedUntil(user, "login");
  if (locked) throw loginLockedError(locked);
  if (await verifyPassword(password, user.passwordHash)) return;
  const until = await recordFailure(user, "login");
  if (until) throw loginLockedError(until);
  throw clientError(400, "Your current password isn’t right.");
}

// ---------- Helpers ----------

// An error whose message is written for the form that sent the request.
function clientError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function currentUserId(req) {
  return req.session.userId ? new ObjectId(req.session.userId) : null;
}

function requireLogin(req, res, next) {
  if (!req.session.userId) return next(clientError(401, "Please log in first."));
  next();
}

// Guest orders and quiz runs made in this browser session, so logging in can move them to the
// account (this replaces the sessionStorage list app.js used to keep).
function rememberGuestItem(req, kind, id) {
  if (req.session.userId) return;
  const items = (req.session.guestItems ||= { orders: [], quizzes: [] });
  items[kind].push(String(id));
}

function guestIds(req, kind) {
  const items = req.session.guestItems;
  return items ? items[kind].map((id) => new ObjectId(id)) : [];
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

// Logs `user` in on a fresh session (a new session ID, so an old cookie can't ride along) and
// moves this visit's guest orders and quiz runs to the account.
async function startSession(req, user) {
  const orderIds = guestIds(req, "orders");
  const quizIds = guestIds(req, "quizzes");
  await regenerateSession(req);
  req.session.userId = String(user._id);
  req.session.username = user.username;
  // A copy for the header's "Admin" link only; admin routes check the database every time.
  req.session.role = user.role || "customer";

  const claim = (collection, ids) =>
    ids.length
      ? db.collection(collection).updateMany({ _id: { $in: ids }, userId: null }, { $set: { userId: user._id } })
      : { modifiedCount: 0 };
  const [orders, quizzes] = await Promise.all([claim("orders", orderIds), claim("quizResults", quizIds)]);
  return {
    username: user.username,
    role: req.session.role,
    claimed: { orders: orders.modifiedCount, quizzes: quizzes.modifiedCount },
  };
}

// Database documents -> the shapes the pages use.

// The account page shows which questions are set (their wording), never the answer hashes.
function toClientAccount(user) {
  const questions = user.securityQuestions ? user.securityQuestions.map((q) => SECURITY_QUESTIONS[q.questionId]) : null;
  return { username: user.username, role: user.role, securityQuestions: questions };
}

function toClientOrder(order, username) {
  const { _id, userId, createdAt, ...rest } = order;
  return { ...rest, username, createdAt: createdAt.toISOString() };
}

function toClientReview(review) {
  const { _id, userId, ...rest } = review;
  return rest;
}

function toClientQuizResult(result, username) {
  return { username, productIds: result.productIds, takenAt: result.takenAt.toISOString() };
}

function makeOrderId() {
  const suffix = crypto.randomInt(36 * 36).toString(36).padStart(2, "0");
  return `EB-${Date.now().toString(36)}${suffix}`.toUpperCase();
}

// ---------- App ----------

const app = express();
app.disable("x-powered-by");

app.use(
  session({
    name: "eb.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // guests get a session only once they save something
    store: MongoStore.create({ client, dbName: DB_NAME, ttl: SESSION_DAYS * 24 * 60 * 60 }),
    cookie: { httpOnly: true, sameSite: "lax", maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 },
  })
);

const api = express.Router();

// Writes must be JSON. A plain HTML form on another site can't send that, which (with the
// sameSite cookie) keeps other sites from posting as a logged-in customer.
api.use((req, res, next) => {
  if (req.method !== "GET" && typeis.hasBody(req) && !req.is("application/json")) return next(clientError(415, "Send JSON."));
  next();
});
api.use(express.json({ limit: "20kb" }));
// A POST with no body (e.g. logout) gets an empty object, so handlers can read req.body safely.
api.use((req, res, next) => {
  if (!req.body || typeof req.body !== "object") req.body = {};
  next();
});

// ---------- Session + accounts ----------

api.get("/session", async (req, res) => {
  if (!req.session.userId) return res.json({ username: null, role: null });
  // The role comes from the database, so a role an admin just changed shows on the next page.
  const user = await db.collection("users").findOne({ _id: currentUserId(req) }, { projection: { role: 1 } });
  res.json({ username: req.session.username, role: (user && user.role) || "customer" });
});

api.post("/signup", async (req, res) => {
  const username = text(req.body.username);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!USERNAME_PATTERN.test(username)) throw clientError(400, "Use 3–30 letters, numbers, dots, dashes or underscores.");
  if (password.length < MIN_PASSWORD_LENGTH) throw clientError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  const securityQuestions = await securityQuestionsFrom(req.body.securityQuestions);

  // Signing up logs the new customer straight in, so it counts as their first login.
  const now = new Date();
  // Always a customer: admins are only made in the database (see SCHEMA.md), never from the site.
  const user = { username, passwordHash: await hashPassword(password), role: "customer", securityQuestions, createdAt: now, lastLoginAt: now };
  try {
    const result = await db.collection("users").insertOne(user);
    user._id = result.insertedId;
  } catch (err) {
    if (err.code === 11000) throw clientError(409, "That username is already taken.");
    throw err;
  }
  res.status(201).json(await startSession(req, user));
});

api.post("/login", async (req, res) => {
  const username = text(req.body.username);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const users = db.collection("users");
  const user = USERNAME_PATTERN.test(username) ? await users.findOne({ username }, { collation: CASE_INSENSITIVE }) : null;
  // A locked account is refused even with the right password, so guessing stays useless.
  const locked = lockedUntil(user, "login");
  if (locked) throw loginLockedError(locked);

  const valid = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
  if (!user || !valid) {
    if (user) {
      const until = await recordFailure(user, "login");
      if (until) throw loginLockedError(until);
    }
    // The form doesn't say whether the username or the password was wrong.
    throw clientError(401, "Username or password is incorrect.");
  }

  await users.updateOne({ _id: user._id }, withUpdates({ $set: { lastLoginAt: new Date() } }, clearLock("login")));
  res.json(await startSession(req, user));
});

api.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("eb.sid");
    res.json({ username: null });
  });
});

api.get("/me", requireLogin, async (req, res) => {
  const user = await db.collection("users").findOne({ _id: currentUserId(req) });
  if (!user) throw clientError(401, "Please log in first.");
  res.json(toClientAccount(user));
});

// Changing the questions takes the current password, so a borrowed logged-in browser can't
// set answers that let someone take the account later.
api.post("/me/security-questions", requireLogin, async (req, res) => {
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const users = db.collection("users");
  const user = await users.findOne({ _id: currentUserId(req) });
  if (!user) throw clientError(401, "Please log in first.");
  await checkCurrentPassword(user, password);

  const securityQuestions = await securityQuestionsFrom(req.body.securityQuestions);
  await users.updateOne({ _id: user._id }, withUpdates({ $set: { securityQuestions } }, clearLock("reset"), clearLock("login")));
  res.json(toClientAccount({ ...user, securityQuestions }));
});

// Changing the password while logged in. Other devices are logged out, this one stays in.
api.post("/me/password", requireLogin, async (req, res) => {
  const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw clientError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);

  const users = db.collection("users");
  const user = await users.findOne({ _id: currentUserId(req) });
  if (!user) throw clientError(401, "Please log in first.");
  await checkCurrentPassword(user, currentPassword);
  if (newPassword === currentPassword) throw clientError(400, "Choose a new password that’s different from your current one.");

  await users.updateOne({ _id: user._id }, withUpdates({ $set: { passwordHash: await hashPassword(newPassword) } }, clearLock("login")));
  const { deletedCount } = await db
    .collection("sessions")
    .deleteMany({ _id: { $ne: req.sessionID }, session: { $regex: `"userId":"${user._id}"` } });
  res.json({ username: user.username, otherSessionsEnded: deletedCount });
});

// ---------- Password reset (security questions) ----------

// The list sign-up and the account page choose from.
api.get("/security-questions", (req, res) => {
  res.json(Object.entries(SECURITY_QUESTIONS).map(([id, question]) => ({ id, question })));
});

// Step 1: the questions for a username. Unknown usernames get decoys (see decoyQuestionIds),
// so the answer looks the same whether or not the account exists.
api.post("/password/questions", async (req, res) => {
  const username = text(req.body.username);
  if (!USERNAME_PATTERN.test(username)) throw clientError(400, "Please enter your username.");
  const user = await db.collection("users").findOne({ username }, { collation: CASE_INSENSITIVE });
  const ids = user && user.securityQuestions ? user.securityQuestions.map((q) => q.questionId) : decoyQuestionIds(username);
  res.json({ questions: ids.map((id) => SECURITY_QUESTIONS[id]) });
});

// Step 2: both answers and the new password. Both answers are always checked (against stand-in
// hashes when there's no account), so the response time doesn't show which part was wrong or
// whether the account exists.
api.post("/password/reset", async (req, res) => {
  const username = text(req.body.username);
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) throw clientError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (answers.length !== QUESTIONS_PER_ACCOUNT) throw clientError(400, "Please answer both security questions.");

  const users = db.collection("users");
  const user = USERNAME_PATTERN.test(username) ? await users.findOne({ username }, { collation: CASE_INSENSITIVE }) : null;
  const locked = lockedUntil(user, "reset");
  if (locked) throw resetLockedError(locked);

  const hasQuestions = Boolean(user && user.securityQuestions);
  const hashes = hasQuestions ? user.securityQuestions.map((q) => q.answerHash) : [await dummyHash, await dummyHash];
  const matches = await Promise.all(hashes.map((hash, i) => verifyPassword(normalizeAnswer(answers[i]), hash)));

  if (!hasQuestions || !matches.every(Boolean)) {
    if (user) {
      const until = await recordFailure(user, "reset");
      if (until) throw resetLockedError(until);
    }
    throw clientError(400, "Those answers don’t match. Check them and try again.");
  }

  await users.updateOne(
    { _id: user._id },
    // Answering the questions proves it's the owner, so it also ends a login lock.
    withUpdates({ $set: { passwordHash: await hashPassword(password), lastLoginAt: new Date() } }, clearLock("reset"), clearLock("login"))
  );
  // Log the account out everywhere, in case someone else knew the old password.
  // (connect-mongo stores each session as a JSON string.)
  await db.collection("sessions").deleteMany({ session: { $regex: `"userId":"${user._id}"` } });
  res.json(await startSession(req, user));
});

// ---------- Products + reviews ----------

api.get("/products", async (req, res) => {
  res.json(await db.collection("products").find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray());
});

api.get("/reviews", async (req, res) => {
  const productId = text(req.query.productId);
  const filter = PRODUCT_ID_PATTERN.test(productId) ? { productId } : {};
  const reviews = await db.collection("reviews").find(filter).sort({ date: -1, _id: -1 }).toArray();
  res.json(reviews.map(toClientReview));
});

api.get("/me/reviews", requireLogin, async (req, res) => {
  const reviews = await db.collection("reviews").find({ userId: currentUserId(req) }).sort({ date: -1, _id: -1 }).toArray();
  res.json(reviews.map(toClientReview));
});

api.post("/reviews", requireLogin, async (req, res) => {
  const { productId, rating, date } = req.body;
  const comment = text(req.body.comment);
  // MongoDB doesn't enforce the reference to products.id, so it's checked here.
  if (typeof productId !== "string" || !(await db.collection("products").countDocuments({ id: productId }))) {
    throw clientError(400, "Please choose a coffee to review.");
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw clientError(400, "Please choose a rating from 1 to 5 stars.");
  if (!comment) throw clientError(400, "Please write a comment before submitting.");
  if (comment.length > 1000) throw clientError(400, "Please keep your review to 1000 characters.");
  // The customer's own calendar day (app.js localDateString), so it's taken from the browser.
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) throw clientError(400, "The review date is missing.");

  const review = { productId, userId: currentUserId(req), name: req.session.username, rating, comment, date };
  await db.collection("reviews").insertOne(review);
  res.status(201).json(toClientReview(review));
});

// ---------- Orders ----------

api.get("/orders", requireLogin, async (req, res) => {
  const orders = await db.collection("orders").find({ userId: currentUserId(req) }).sort({ createdAt: -1 }).toArray();
  res.json(orders.map((o) => toClientOrder(o, req.session.username)));
});

// The browser sends what's in the cart; prices, totals and availability come from the products
// collection, so an edited cart can't change what an order costs.
api.post("/orders", async (req, res) => {
  const body = req.body.customer || {};
  const customer = {
    name: text(body.name),
    email: text(body.email),
    address: text(body.address),
    city: text(body.city),
    state: text(body.state).toUpperCase(),
    zip: text(body.zip),
  };
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (!lines.length) throw clientError(400, "Your cart is empty.");

  const ids = [...new Set(lines.map((line) => String(line.productId)))];
  const products = await db.collection("products").find({ id: { $in: ids } }).toArray();
  const productsById = Object.fromEntries(products.map((p) => [p.id, p]));

  const items = lines.map((line) => {
    const product = productsById[line.productId];
    const option = product && product.options.find((o) => o.name === line.option);
    if (!option) throw clientError(400, "Something in your cart is no longer sold. Please remove it and try again.");
    if (!product.inStock || !option.available) throw clientError(409, `${product.name} (${option.name}) is sold out. Please remove it and try again.`);
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) throw clientError(400, `Quantities must be 1 to ${MAX_QTY}.`);
    return { productId: product.id, name: product.name, option: option.name, unitPrice: option.salePrice ?? option.price, qty: line.qty };
  });

  // Rounded to whole cents so float drift never reaches the stored totals.
  const cents = (amount) => Math.round(amount * 100) / 100;
  const subtotal = cents(items.reduce((sum, line) => sum + line.unitPrice * line.qty, 0));
  const shipping = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
  const total = cents(subtotal + shipping);

  const order = {
    orderId: makeOrderId(),
    userId: currentUserId(req),
    customer,
    items,
    totals: { subtotal, shipping, total },
    amountCents: Math.round(total * 100),
    status: "pending_payment",
    createdAt: new Date(),
  };
  try {
    await db.collection("orders").insertOne(order);
  } catch (err) {
    // The checkout form checks these fields too; this catches anything that slipped past it.
    if (err.code === 121) throw clientError(400, "Please check your shipping details.");
    throw err;
  }
  rememberGuestItem(req, "orders", order._id);
  res.status(201).json(toClientOrder(order, req.session.username || null));
});

// ---------- Quiz results ----------

api.post("/quiz-results", async (req, res) => {
  const { productIds } = req.body;
  if (!Array.isArray(productIds) || !productIds.length || !productIds.every((id) => typeof id === "string" && PRODUCT_ID_PATTERN.test(id))) {
    throw clientError(400, "The quiz result is missing its coffees.");
  }
  const result = { userId: currentUserId(req), productIds: [...new Set(productIds)], takenAt: new Date() };
  await db.collection("quizResults").insertOne(result);
  rememberGuestItem(req, "quizzes", result._id);
  res.status(201).json(toClientQuizResult(result, req.session.username || null));
});

// The latest run for whoever is browsing: their own when logged in, else this guest session's.
api.get("/quiz-results/latest", async (req, res) => {
  const userId = currentUserId(req);
  const filter = userId ? { userId } : { _id: { $in: guestIds(req, "quizzes") }, userId: null };
  const result = await db.collection("quizResults").findOne(filter, { sort: { takenAt: -1 } });
  res.json(result ? toClientQuizResult(result, req.session.username || null) : null);
});

// ---------- Contact messages ----------

api.post("/messages", async (req, res) => {
  const message = {
    userId: currentUserId(req),
    name: text(req.body.name),
    email: text(req.body.email),
    topic: text(req.body.topic),
    orderId: text(req.body.orderId) || null,
    message: text(req.body.message),
    status: "new",
    createdAt: new Date(),
  };
  if (message.topic !== "order" || (message.orderId && !ORDER_ID_PATTERN.test(message.orderId))) message.orderId = null;
  try {
    await db.collection("messages").insertOne(message);
  } catch (err) {
    if (err.code === 121) throw clientError(400, "Please check the form and try again.");
    throw err;
  }
  res.status(201).json({ name: message.name, email: message.email });
});

// ---------- Admin (admin.html) ----------

// Every admin route checks the role in the database on each request, not the copy in the
// session, so taking away someone's admin role works straight away. Customers get 403.
async function requireAdmin(req, res, next) {
  if (!req.session.userId) throw clientError(401, "Please log in first.");
  const user = await db.collection("users").findOne({ _id: currentUserId(req) }, { projection: { role: 1 } });
  if (!user || user.role !== "admin") throw clientError(403, "Only admins can do that.");
  next();
}

const admin = express.Router();
admin.use(requireAdmin);
api.use("/admin", admin);

// { "<userId>": "username" } for the accounts behind a list of orders or messages.
async function usernamesFor(docs) {
  const ids = [...new Set(docs.filter((d) => d.userId).map((d) => String(d.userId)))].map((id) => new ObjectId(id));
  const users = await db.collection("users").find({ _id: { $in: ids } }, { projection: { username: 1 } }).toArray();
  return Object.fromEntries(users.map((u) => [String(u._id), u.username]));
}

// The account an order or message came from: its username, null for a guest, or a note when
// the account has since been deleted.
function accountName(doc, names) {
  if (!doc.userId) return null;
  return names[String(doc.userId)] || "(deleted account)";
}

admin.get("/orders", async (req, res) => {
  const orders = await db.collection("orders").find().sort({ createdAt: -1 }).toArray();
  const names = await usernamesFor(orders);
  res.json(orders.map((o) => toClientOrder(o, accountName(o, names))));
});

admin.post("/orders/:orderId/status", async (req, res) => {
  const { orderId } = req.params;
  const status = text(req.body.status);
  if (!ORDER_STATUSES.includes(status)) throw clientError(400, "Choose one of the order statuses.");
  const result = await db.collection("orders").updateOne({ orderId }, { $set: { status } });
  if (!result.matchedCount) throw clientError(404, "That order doesn’t exist any more.");
  res.json({ orderId, status });
});

admin.get("/messages", async (req, res) => {
  const messages = await db.collection("messages").find().sort({ createdAt: -1 }).toArray();
  const names = await usernamesFor(messages);
  // Messages have no number of their own, so the admin page refers to them by _id.
  res.json(
    messages.map(({ _id, userId, createdAt, ...rest }) => ({
      ...rest,
      id: String(_id),
      username: accountName({ userId }, names),
      createdAt: createdAt.toISOString(),
    }))
  );
});

admin.post("/messages/:id/status", async (req, res) => {
  const status = text(req.body.status);
  if (!MESSAGE_STATUSES.includes(status)) throw clientError(400, "Choose one of the message statuses.");
  if (!ObjectId.isValid(req.params.id)) throw clientError(404, "That message doesn’t exist any more.");
  const result = await db.collection("messages").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
  if (!result.matchedCount) throw clientError(404, "That message doesn’t exist any more.");
  res.json({ id: req.params.id, status });
});

// { inStock, options: [{ name, available, salePrice }] }. Prices and option names can't be
// changed here, only what's for sale and at what discount.
admin.post("/products/:id", async (req, res) => {
  const products = db.collection("products");
  const product = await products.findOne({ id: req.params.id });
  if (!product) throw clientError(404, "That coffee doesn’t exist any more.");
  const { inStock } = req.body;
  if (typeof inStock !== "boolean") throw clientError(400, "Say whether the coffee is in stock.");
  const changes = Array.isArray(req.body.options) ? req.body.options : [];

  const options = product.options.map((option) => {
    const change = changes.find((c) => c && c.name === option.name);
    if (!change) return option;
    if (typeof change.available !== "boolean") throw clientError(400, `Say whether ${option.name} is available.`);
    let { salePrice } = change;
    if (salePrice !== null) {
      const inCents = typeof salePrice === "number" && Math.abs(Math.round(salePrice * 100) - salePrice * 100) < 1e-6;
      if (!inCents || salePrice <= 0 || salePrice >= option.price) {
        throw clientError(400, `${option.name}: a sale price must be in dollars and cents and less than the regular $${option.price}.`);
      }
      salePrice = Math.round(salePrice * 100) / 100;
    }
    return { ...option, available: change.available, salePrice };
  });

  await products.updateOne({ id: product.id }, { $set: { inStock, options } });
  const { _id, ...rest } = product;
  res.json({ ...rest, inStock, options });
});

// ---------- Admin: users (fixing the users collection) ----------

const ROLES = ["customer", "admin"];

// A hash this server can check. bcrypt and argon2 hashes pass the validator but this server only
// verifies PBKDF2, and create-users.js's sample hashes are placeholders, so neither can log in.
function isUsableHash(hash) {
  return typeof hash === "string" && /^pbkdf2-sha256\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hash) && !hash.includes("PLACEHOLDER");
}

// The _ids of user documents that break the collection's current validation rules. They can
// exist when a rule was added after the document was saved; MongoDB then refuses updates to them
// that don't fix the problem.
async function usersBreakingRules() {
  const [info] = await db.listCollections({ name: "users" }).toArray();
  const validator = info && info.options && info.options.validator;
  if (!validator) return new Set();
  const docs = await db.collection("users").find({ $nor: [validator] }, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((d) => String(d._id)));
}

// What the Users tab shows for an account, with a list of what needs fixing. Never any hashes.
function toAdminUser(u, { ordersBy, breaking, selfId }) {
  const now = new Date();
  const loginLockedUntil = u.loginLockedUntil > now ? u.loginLockedUntil.toISOString() : null;
  const resetLockedUntil = u.resetLockedUntil > now ? u.resetLockedUntil.toISOString() : null;
  const problems = [];
  if (breaking.has(String(u._id))) {
    problems.push({ code: "rules", text: "Breaks the collection’s validation rules, so MongoDB refuses other changes until the problems below are fixed." });
  }
  if (!ROLES.includes(u.role)) problems.push({ code: "role", text: "Has no role. Choose Customer or Admin." });
  if (!isUsableHash(u.passwordHash)) problems.push({ code: "password", text: "Its password can’t be used to log in (a placeholder or unsupported hash). Set a temporary password." });
  if (!u.securityQuestions) problems.push({ code: "questions", text: "No security questions, so “Forgot password?” can’t be used. Only the customer can add them." });
  if (loginLockedUntil) problems.push({ code: "loginLocked", text: "Login is locked after 10 wrong passwords." });
  if (resetLockedUntil) problems.push({ code: "resetLocked", text: "Password reset is locked after 5 wrong answers." });
  return {
    username: u.username,
    role: u.role || null,
    isYou: String(u._id) === selfId,
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : null,
    lastLoginAt: u.lastLoginAt instanceof Date ? u.lastLoginAt.toISOString() : null,
    hasSecurityQuestions: Boolean(u.securityQuestions),
    loginFailures: u.loginFailures || 0,
    loginLockedUntil,
    resetFailures: u.resetFailures || 0,
    resetLockedUntil,
    orders: ordersBy[String(u._id)] || 0,
    problems,
  };
}

async function adminUserView(req, username) {
  const users = db.collection("users");
  const user = await users.findOne({ username }, { collation: CASE_INSENSITIVE });
  if (!user) throw clientError(404, "That account doesn’t exist any more.");
  const orders = await db.collection("orders").countDocuments({ userId: user._id });
  return toAdminUser(user, { ordersBy: { [String(user._id)]: orders }, breaking: await usersBreakingRules(), selfId: req.session.userId });
}

// The account named in the URL, or 404.
async function findUserOr404(username) {
  const user = await db.collection("users").findOne({ username }, { collation: CASE_INSENSITIVE });
  if (!user) throw clientError(404, "That account doesn’t exist any more.");
  return user;
}

function isSelf(req, user) {
  return String(user._id) === req.session.userId;
}

// Logs an account out everywhere, except this admin's own browser when it's their account.
function endSessions(req, user) {
  return db.collection("sessions").deleteMany({ _id: { $ne: req.sessionID }, session: { $regex: `"userId":"${user._id}"` } });
}

// An update to a user that MongoDB's rules refuse gets a message saying what to do.
async function updateUser(user, update) {
  try {
    return await db.collection("users").updateOne({ _id: user._id }, update);
  } catch (err) {
    if (err.code === 121) {
      throw clientError(400, "MongoDB refused this change because the account breaks the collection’s rules. Fix the problems listed for it first, starting with its role.");
    }
    throw err;
  }
}

admin.get("/users", async (req, res) => {
  const users = await db.collection("users").find().sort({ createdAt: 1, _id: 1 }).toArray();
  const counts = await db.collection("orders").aggregate([{ $match: { userId: { $ne: null } } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray();
  const ordersBy = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  const breaking = await usersBreakingRules();
  res.json(users.map((u) => toAdminUser(u, { ordersBy, breaking, selfId: req.session.userId })));
});

// Clears both lockouts (login and "Forgot password?") and their counts, e.g. after checking
// with the customer that the failed tries were theirs.
admin.post("/users/:username/unlock", async (req, res) => {
  const user = await findUserOr404(req.params.username);
  await updateUser(user, withUpdates(clearLock("login"), clearLock("reset")));
  res.json(await adminUserView(req, user.username));
});

admin.post("/users/:username/role", async (req, res) => {
  const role = text(req.body.role);
  if (!ROLES.includes(role)) throw clientError(400, "Choose Customer or Admin.");
  const user = await findUserOr404(req.params.username);
  if (isSelf(req, user) && role !== "admin") throw clientError(400, "You can’t remove your own admin role. Ask another admin.");
  await updateUser(user, { $set: { role } });
  res.json(await adminUserView(req, user.username));
});

admin.post("/users/:username/rename", async (req, res) => {
  const newUsername = text(req.body.newUsername);
  if (!USERNAME_PATTERN.test(newUsername)) throw clientError(400, "Use 3–30 letters, numbers, dots, dashes or underscores.");
  const user = await findUserOr404(req.params.username);
  try {
    await updateUser(user, { $set: { username: newUsername } });
  } catch (err) {
    if (err.code === 11000) throw clientError(409, "That username is already taken.");
    throw err;
  }
  // Reviews show the writer's username, so they follow the new name.
  await db.collection("reviews").updateMany({ userId: user._id }, { $set: { name: newUsername } });
  // Sessions keep a copy of the username: this admin's own is updated; anyone else logs in again.
  if (isSelf(req, user)) req.session.username = newUsername;
  await endSessions(req, user);
  res.json(await adminUserView(req, newUsername));
});

// Sets a password the admin then gives the customer, e.g. when they're locked out and have no
// security questions. Logs that account out everywhere.
admin.post("/users/:username/password", async (req, res) => {
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) throw clientError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  const user = await findUserOr404(req.params.username);
  await updateUser(user, withUpdates({ $set: { passwordHash: await hashPassword(password) } }, clearLock("login")));
  const { deletedCount } = await endSessions(req, user);
  res.json({ ...(await adminUserView(req, user.username)), sessionsEnded: deletedCount });
});

// Removes the questions (e.g. the customer forgot the answers), so they set new ones on their
// account page. Answers are never shown or set by an admin.
admin.post("/users/:username/clear-questions", async (req, res) => {
  const user = await findUserOr404(req.params.username);
  await updateUser(user, withUpdates({ $unset: { securityQuestions: "" } }, clearLock("reset")));
  res.json(await adminUserView(req, user.username));
});

// Deletes the account but keeps its orders, reviews, quiz results and messages as guest records,
// since they're still the shop's history.
admin.post("/users/:username/delete", async (req, res) => {
  const user = await findUserOr404(req.params.username);
  if (isSelf(req, user)) throw clientError(400, "You can’t delete your own account while logged in to it.");
  const kept = {};
  for (const collection of ["orders", "reviews", "quizResults", "messages"]) {
    kept[collection] = (await db.collection(collection).updateMany({ userId: user._id }, { $set: { userId: null } })).modifiedCount;
  }
  await endSessions(req, user);
  await db.collection("users").deleteOne({ _id: user._id });
  res.json({ username: user.username, deleted: true, kept });
});

// ---------- Admin: database overview ----------

// Every collection with its document count, validation rules and indexes. Read-only.
admin.get("/database", async (req, res) => {
  const infos = (await db.listCollections().toArray()).filter((c) => c.type === "collection" && !c.name.startsWith("system."));
  infos.sort((a, b) => a.name.localeCompare(b.name));
  const collections = await Promise.all(
    infos.map(async (info) => {
      const collection = db.collection(info.name);
      const [documents, indexes] = await Promise.all([collection.countDocuments(), collection.indexes()]);
      return {
        name: info.name,
        documents,
        hasValidator: Boolean(info.options && info.options.validator),
        validationLevel: (info.options && info.options.validationLevel) || null,
        indexes: indexes.map((i) => ({
          name: i.name,
          keys: Object.entries(i.key).map(([field, order]) => `${field} ${order === 1 ? "ascending" : order === -1 ? "descending" : order}`),
          unique: Boolean(i.unique),
          caseInsensitive: Boolean(i.collation && i.collation.strength === 2),
          expiresAfterSeconds: i.expireAfterSeconds ?? null,
        })),
      };
    })
  );
  res.json({ database: DB_NAME, collections });
});

api.use((req, res, next) => next(clientError(404, "Not found.")));

app.use("/api", api);

// ---------- Pages ----------

// Only the site's own files are public; server.js, package.json, .env, mongo/, node_modules/,
// the Angular source (admin-app/) and the coursework folder are not. admin/ is the built Angular
// admin app (npm run build:admin); its pages only show data the /api/admin routes allow.
const PUBLIC_FILE = /^\/(?:[a-z-]+\.html|styles\.css|app\.js|[\w-]+\.jpg|data\/[\w-]+\.(?:js|json)|admin\/(?:index\.html|[\w-]+\.(?:js|css)))$/;

// The Angular app's links are relative to /admin/, so the address needs the trailing slash.
// (Compares req.path exactly: Express routes ignore a trailing slash, so app.get("/admin") would
// also catch /admin/ and redirect forever.)
app.use((req, res, next) => (req.path === "/admin" ? res.redirect(301, "/admin/") : next()));
app.use((req, res, next) => (req.path === "/" || req.path === "/admin/" || PUBLIC_FILE.test(req.path) ? next() : res.status(404).send("Not found")));
app.use(express.static(ROOT, { index: "index.html", dotfiles: "deny" }));
app.use((req, res) => res.status(404).send("Not found"));

// ---------- Errors ----------

app.use((err, req, res, next) => {
  if (err.code === 11000) err = clientError(409, "That already exists.");
  if (err.code === 121) err = clientError(400, "Some details didn't pass the database's checks.");
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.expose ? err.message : "Something went wrong on our end. Please try again." });
});

// ---------- Start ----------

async function start() {
  try {
    await client.connect();
    await db.command({ ping: 1 });
  } catch (err) {
    console.error(`Could not connect to MongoDB at ${MONGODB_URI}. Is the MongoDB service running?\n${err.message}`);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Equity Beans is running at http://localhost:${PORT}`));
}

start();
