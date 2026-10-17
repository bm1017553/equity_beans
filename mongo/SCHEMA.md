# Equity Beans: MongoDB data model

Database **`equity_beans`**. Five collections, with every field's name and BSON type declared
before anything connects to a database.

Nothing in this folder touches the running website. A `$jsonSchema` validator is an ordinary JSON
file until someone pastes it into Compass or runs a `create-*.js` script against a cluster, and the
site keeps reading its data from `data/*.json` on disk either way. See
[Later: connecting the website](#later-connecting-the-website).

| Collection    | One document is                   | Sample documents live in                                                                 |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `products`    | A coffee sold on the site         | [`../data/products.json`](../data/products.json) (17 coffees, the file the site reads)   |
| `reviews`     | One customer review of one coffee | [`../data/reviews.json`](../data/reviews.json) (3 seed reviews, the file the site reads) |
| `users`       | A customer account                | Inline in `create-users.js`                                                              |
| `orders`      | A completed checkout              | Inline in `create-orders.js`                                                             |
| `quizResults` | One run through the coffee quiz   | Inline in `create-quizResults.js`                                                        |

`products` and `reviews` keep their samples in `data/` because the website fetches those two files
today. `users`, `orders` and `quizResults` have no disk equivalent — the site keeps them in
`localStorage` — so their samples live in the create scripts instead.

## Files

| File                          | What it is                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<collection>.validator.json` | `$jsonSchema` validator. MongoDB rejects any document whose fields have the wrong type.                                                                                |
| `create-<collection>.js`      | `mongosh` script: creates the collection with the validator, adds indexes, inserts the samples, prints type checks, and demonstrates the validator rejecting bad data. |

## Create a collection

**Option A: MongoDB Compass or Atlas (no command line)**

1. Connect to your cluster and create database `equity_beans` with the collection you want.
2. Open the collection's **Validation** tab, paste the contents of that collection's
   `.validator.json`, set _Validation Action_ to **Error** and _Validation Level_ to **Strict**,
   and save.
3. **Indexes** tab → **Create Index**, using the indexes listed per collection below.
4. For `products` and `reviews`: **Add Data → Import JSON or CSV file** → choose the matching
   `data/*.json`. For the other three, run the script in Option B or add documents by hand.

**Option B: `mongosh`** (run from the project folder)

```sh
mongosh "<your connection string>" mongo/create-products.js
mongosh "<your connection string>" mongo/create-reviews.js
mongosh "<your connection string>" mongo/create-users.js
mongosh "<your connection string>" mongo/create-orders.js
mongosh "<your connection string>" mongo/create-quizResults.js
```

Each script drops and recreates its collection, so re-running one starts fresh. Order doesn't
matter: the collections reference each other by value, not by database constraint.

## Conventions used across all five collections

These four decisions were made once and applied everywhere, so the collections agree with each
other and with the JavaScript.

**1. Dates: calendar days are strings, timestamps are BSON dates.**

| Kind                       | Type                | Fields                                                                            | Why                                                                                                                                                        |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A day a person picked      | string `YYYY-MM-DD` | `reviews.date`                                                                    | `localDateString()` in `app.js` deliberately avoids `toISOString()`, which is already tomorrow on a US evening. These strings also sort correctly as text. |
| A moment the code recorded | BSON `date`         | `orders.createdAt`, `quizResults.takenAt`, `users.createdAt`, `users.lastLoginAt` | Real dates allow `$dateTrunc`, date ranges, and "orders this month" aggregations. `create-orders.js` demonstrates one.                                     |

This matches what the site already does, but it leaves a conversion for later — see
[the API boundary](#the-conversion-the-api-will-have-to-make) below.

**2. Money: dollars as `number`, the charged amount as integer cents.**

Prices (`products.options[].price`, `orders.items[].unitPrice`, `orders.totals.*`) are plain
numbers in dollars, because that's how `formatMoney()` and the cart totals already treat them.
`orders.amountCents` is an `int` of whole cents, which is what Square's `CreatePayment` expects and
what avoids floating-point drift on the one number that actually gets charged.

`Decimal128` is the textbook answer for money and would be the right call for a real store's
ledger. It is not used here because it would break the existing float arithmetic in `app.js` for no
practical gain at this size. Recording the tradeoff is the point.

**3. `int` where only whole numbers make sense, `number` for prices.**

`reviews.rating`, `orders.items[].qty` and `orders.amountCents` are `int`, so a 4.5-star rating or
a quantity of 1.5 is rejected outright. Prices stay `number` because whole prices like `50` import
as BSON `int` while `49.5` imports as `double`, and both must be allowed.

> **Gotcha:** Compass's JSON import, `mongosh` and the Node driver all store a whole JavaScript
> number like `5` as `int` and a fractional one like `4.5` as `double` (checked against
> mongosh 2.13). So an `int` field passes only if the number really is whole. Floating-point
> math can quietly break that: `0.1 * 3 * 100` is `30.000000000000004`, a `double`, and would be
> rejected. That's why `amountCents` is always computed with `Math.round(total * 100)`.

**4. Joins are by the four-digit product code, not `_id`.**

`products.id` (a string like `"1001"`) is the key every other collection references:
`reviews.productId`, `orders.items[].productId`, `quizResults.productIds[]`. This is what makes
`product.html?id=1001` work, and it keeps URLs stable and readable. MongoDB doesn't enforce these
references — nothing stops a review pointing at a deleted coffee — so the API has to check, and
each validator names the relationship in its `description`.

`users._id` is the exception: `orders.userId`, `quizResults.userId` and `reviews.userId` reference a
real `objectId`, or hold `null` for guest checkout, logged-out quiz runs and the seed reviews. `null` is used rather than omitting the
field, so "no account" is explicit and queryable with `{ userId: null }`.

---

## `products`

One document per coffee sold on the site. Sample documents are the 17 coffees in
[`../data/products.json`](../data/products.json), the same file the website reads, so the database
and the front end use identical field names and types.

**Indexes:** `id` (unique) — the website looks coffees up by this key.

| Field                 | BSON type                            | JavaScript type    | Used on the site for                                                  |
| --------------------- | ------------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `_id`                 | objectId                             | (added by MongoDB) | Internal document ID                                                  |
| `id`                  | string (4 digits)                    | string             | Product code in URLs: `product.html?id=1001` (unique index)           |
| `name`                | string                               | string             | Card titles, product page heading, cart lines                         |
| `country`             | string                               | string             | Card subtitle, specs                                                  |
| `region`              | string (one of 6)                    | string             | Origin filter, colored region tag, quiz scoring                       |
| `roast`               | string (`Light` / `Medium` / `Dark`) | string             | Roast filter, roast tag, quiz scoring                                 |
| `tastingNotes`        | string                               | string             | Cards, product page, recommendations                                  |
| `flavors`             | array of strings                     | array              | Flavor-matching recommendations and the quiz                          |
| `description`         | string                               | string             | "About this coffee"                                                   |
| `image`, `imageAlt`   | string                               | string             | Product photo and its alt text                                        |
| `certification`       | string                               | string             | Specs list                                                            |
| `type`                | string                               | string             | Specs list                                                            |
| `inStock`             | **bool**                             | boolean            | `false` → "Out of stock" tag, Add to Cart disabled, never recommended |
| `options`             | array of objects                     | array              | Purchase option dropdown                                              |
| `options[].name`      | string (one of 3)                    | string             | Option label                                                          |
| `options[].price`     | number                               | number             | Regular price (US dollars)                                            |
| `options[].salePrice` | number **or null**                   | number / `null`    | Sale price; `null` = not on sale (`salePrice ?? price` in `app.js`)   |
| `options[].available` | **bool**                             | boolean            | `false` → option shown as "(sold out)" and can't be picked            |

### Sample values that show each type

- **Boolean `false`:** `1011` (Kasama Zambian) has `inStock: false`. Two options have `available: false`
  (Whole Bean & Unroasted for `1007` Mandheling and `1009` Da Lat).
- **Number vs null:** `1003` (Cerrado Brazilian) Ground & Roasted has `salePrice: 38`; every option not on
  sale has `salePrice: null`.

---

## `reviews`

One document per review. Today the site merges three seed reviews from
[`../data/reviews.json`](../data/reviews.json) with anything the customer has added in
`localStorage`; this collection is where both end up.

**Indexes:** `productId`; `productId + date` descending for the reviews page's newest-first sort;
`userId + date` descending for the account page's "Your reviews". None is unique — one coffee has
many reviews, and so can one customer.

| Field       | BSON type            | JavaScript type    | Used on the site for                                                |
| ----------- | -------------------- | ------------------ | ------------------------------------------------------------------- |
| `_id`       | objectId             | (added by MongoDB) | Internal document ID                                                |
| `productId` | string (4 digits)    | string             | Foreign key to `products.id`; ties the review to one coffee         |
| `userId`    | objectId **or null** | —                  | The account that wrote it, or `null` (the seed reviews)             |
| `name`      | string               | string             | Reviewer name shown above the review                                |
| `rating`    | **int** (1–5)        | number             | Star display, `averageRating()`, the rating filter and summary bars |
| `comment`   | string (≤ 1000)      | string             | Review body                                                         |
| `date`      | string `YYYY-MM-DD`  | string             | Shown on the review, and the sort key                               |

**Open item:** the validator caps `comment` at 1000 characters, but `reviews.html` has a character
counter with no `maxlength` attribute. Pick one number and set it in both places, or the form will
accept text the database rejects.

**Reviews belong to accounts.** Only a logged-in customer can write one, and the browser records
who with `username` (converted to `userId` at the API, see the table at the end). `name` stays as
the name shown on the review: the username at the time it was written, kept as written the same way
an order keeps its item names. The three seed reviews have `userId: null`, since no account wrote
them. Reviews a browser saved before accounts existed have no `username`, so they aren't claimed by
whoever later signs up under the same name.

---

## `users`

One document per customer account. The sign-up form on `login.html` (**Create an account**)
collects a username and a password and nothing else, so that is all this collection holds. Email is
collected at checkout instead, and lives on `orders.customer.email`.

**Today the accounts live in the browser.** `createAccount()` in `app.js` writes this exact shape,
`{ username, passwordHash, createdAt, lastLoginAt }`, to `localStorage` under `equity_users`, and
`logIn()` checks passwords against it. The rules match the validator: usernames use
`USERNAME_PATTERN` (the same regex as below) and must be unique ignoring case, and passwords need
at least 8 characters. Logging in requires a real account; the old "any username works" demo is
gone, and a leftover demo session is treated as logged out.

**Indexes:** `username` (unique, **case-insensitive**: collation `{ locale: "en", strength: 2 }`).
Login looks an account up by it, and "Maria" and "maria" must never be two accounts. A query only
uses this index if it passes the same collation; `create-users.js` shows the lookup.

| Field          | BSON type           | JavaScript type    | Used on the site for                                            |
| -------------- | ------------------- | ------------------ | --------------------------------------------------------------- |
| `_id`          | objectId            | (added by MongoDB) | Referenced by `userId` in `orders`, `quizResults` and `reviews` |
| `username`     | string (3–30 chars) | string             | Chosen at sign-up, typed at login (case-insensitive unique)     |
| `passwordHash` | string (a hash)     | string             | Login check. With a server, **never sent to the browser**       |
| `createdAt`    | **date**            | Date               | Account age                                                     |
| `lastLoginAt`  | **date or null**    | Date / `null`      | Latest login; sign-up counts as the first, since it logs you in |

### How passwords are stored

`passwordHash` must start with a known hash format, enforced by the validator's `pattern`:

- `pbkdf2-sha256$<iterations>$<salt>$<hash>` — what the site writes today. `hashPassword()` uses
  the browser's Web Crypto: PBKDF2 with SHA-256, a random 16-byte salt, and 600,000 iterations
  (OWASP's recommendation). The algorithm and cost are stored with the hash, so a server can still
  verify it later.
- `$2b$…` (bcrypt) or `$argon2id$…` (argon2) — what a server would write. When the API arrives, it
  can verify a `pbkdf2-sha256` hash at the customer's next login and re-save it as argon2. It
  can't convert one without the password, so it waits for that login.

**Browser accounts are a stand-in, not security.** The hashes keep passwords out of plain sight,
but anyone using that browser can read `localStorage`, and nothing stops someone editing it to log
in as anyone. Real protection needs the server: the hash stays in the database and the browser only
ever gets a session.

### Two things this schema deliberately does not do

- **There is no `password` field, and never will be.** The field is `passwordHash`, and its pattern
  only accepts real hash formats, so a plain password is a validation error even if it's put in
  the right field by mistake. `create-users.js` demonstrates both rejections, and its sample hashes
  are obvious placeholders, not real hashes.
- **`loggedIn` is not stored.** `setSession()` writes `{ loggedIn: true, username }`, but that is
  _session_ state belonging to one browser, not a fact about the account. It stays in
  `localStorage` (and would become a server session or token later).

---

## `orders`

One document per completed checkout. The order object that `checkout.html` already builds was
shaped for this collection, so the field names match it directly.

**Indexes:** `orderId` (unique) for order lookup; `userId + createdAt` descending for an account's
history; `status + createdAt` for a fulfillment queue.

| Field                                    | BSON type            | JavaScript type    | Used on the site for                                                 |
| ---------------------------------------- | -------------------- | ------------------ | -------------------------------------------------------------------- |
| `_id`                                    | objectId             | (added by MongoDB) | Internal document ID                                                 |
| `orderId`                                | string (`EB-…`)      | string             | Order number on the confirmation screen (unique index)               |
| `userId`                                 | objectId **or null** | —                  | The account that ordered, or `null` for guest checkout               |
| `customer`                               | object               | object             | Shipping details from the checkout form                              |
| `customer.name`                          | string               | string             | Confirmation greeting, shipping label                                |
| `customer.email`                         | string               | string             | Confirmation screen, receipts later                                  |
| `customer.address`, `.city`              | string               | string             | Shipping label                                                       |
| `customer.state`                         | string (2 letters)   | string             | Shipping label; the form upper-cases it                              |
| `customer.zip`                           | string (5 digits)    | string             | Shipping label. **A string, not a number** — ZIPs have leading zeros |
| `items`                                  | array of objects     | array              | Order lines on the confirmation screen                               |
| `items[].productId`                      | string (4 digits)    | string             | Foreign key to `products.id`                                         |
| `items[].name`                           | string               | string             | Product name _as it was when ordered_                                |
| `items[].option`                         | string (one of 3)    | string             | Which purchase option                                                |
| `items[].unitPrice`                      | number               | number             | Price actually charged per unit (sale price when on sale)            |
| `items[].qty`                            | **int** (1–10)       | number             | Quantity; matches `MAX_QTY`                                          |
| `totals`                                 | object               | object             | From `cartTotals()`                                                  |
| `totals.subtotal`, `.shipping`, `.total` | number               | number             | Figures shown at checkout, in dollars                                |
| `amountCents`                            | **int**              | number             | `totals.total` in whole cents, for Square                            |
| `status`                                 | string (one of 4)    | string             | `pending_payment` → `paid` → `shipped`, or `cancelled`               |
| `createdAt`                              | **date**             | Date               | Order history, monthly reporting                                     |

### Why the order copies data instead of referencing it

`items[]` stores `name` and `unitPrice` rather than looking them up from `products` at display
time. That looks like duplication, but an order is a record of what someone agreed to pay. If a
coffee's price changes or it's renamed next month, an old order must still show the old figures.
`totals` is stored for the same reason. The `productId` is kept alongside so the order can still
link back to the product page.

This is also why `customer` is embedded rather than referenced: the order has to keep the address it
actually shipped to, even if the account's address changes later.

---

## `quizResults`

One document per run through the coffee quiz. `saveQuizResult()` keeps every run in the browser,
each tagged with the `username` that took it (or `null`), and the shop sidebar and account page
read the latest one for whoever is browsing. A collection keeps the same history across browsers,
which is what makes the aggregations in `create-quizResults.js` possible.

**Indexes:** `userId + takenAt` descending — the shop sidebar shows a customer their latest result.

| Field        | BSON type            | JavaScript type    | Used on the site for                                     |
| ------------ | -------------------- | ------------------ | -------------------------------------------------------- |
| `_id`        | objectId             | (added by MongoDB) | Internal document ID                                     |
| `userId`     | objectId **or null** | —                  | The account that took it, or `null` when logged out      |
| `productIds` | array of strings     | array              | The top matches, **best first**; drives the shop sidebar |
| `takenAt`    | **date**             | Date               | Which result is most recent                              |

`productIds` is an ordered array rather than separate `firstMatch` / `secondMatch` fields because
the ranking is the result, and the number of matches can change as the quiz grows. Position 0 is
the top match, which is how `create-quizResults.js` reports the most common top match.

---

## The conversion the API will have to make

The site's objects almost match these schemas, but not exactly. These fields differ, and all would
fail validation if the browser's JSON were inserted as-is:

| Site writes                                              | Collection expects      | Fix at the API boundary                                    |
| -------------------------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `createdAt: new Date().toISOString()` (orders, users)    | BSON `date`             | `new Date(doc.createdAt)`                                  |
| `lastLoginAt: new Date().toISOString()` (users)          | BSON `date`             | `new Date(user.lastLoginAt)`                               |
| `takenAt: new Date().toISOString()` (quizResults)        | BSON `date`             | `new Date(result.takenAt)`                                 |
| `username: "maria"` or `null` (orders, quiz, reviews)    | `userId`: objectId/null | Look up `users._id` by `username`, then drop `username`    |

The browser has no account IDs, so it records the username. Logging in also moves that visit's
guest quiz runs and orders to the account (`claimGuestItems()` in `app.js`); with a database, that
becomes an update setting `userId` on those documents.

This is a feature of declaring the types up front: the mismatch shows up now, in a table, instead of
as a failed insert later. The `create-*.js` scripts each demonstrate the rejection so the error is
recognizable when it happens.

## Checking the schemas without a database

The validators are plain JSON, so they can be checked offline:

```sh
npx prettier --check mongo/*.json          # valid JSON, consistent formatting
mongosh --nodb mongo/create-reviews.js     # syntax-check a script without connecting
```

`$jsonSchema` is a subset of JSON Schema, so `npx ajv-cli validate` can check sample documents
against the `properties` block too — but note that `ajv` doesn't understand `bsonType`, so it will
ignore exactly the type rules that matter most here. The real type check is the `$type` projection
each `create-*.js` prints once it runs against a cluster.

## Later: connecting the website

Pages read data only through `getProducts()` / `getProduct()` in `app.js`, which bottom out in a
single `loadJson()` call. Once a Node/Express API serves these collections, point
`loadJson("data/products.json")` at `/api/products` and the pages don't need other changes. The
same seam applies to `data/reviews.json` → `/api/reviews`.

`users`, `orders` and `quizResults` have no disk file to swap out — they are written through
`createAccount()` / `logIn()`, `saveOrder()` and `saveQuizResult()`, so those functions are where
the API calls will go, with the conversions in the table above. Password hashing then moves to the
server too: `createAccount()` and `logIn()` would send the password over HTTPS and get back only a
session, never `passwordHash`.

If you edit `data/products.json` before then, run `node data/build-fallback.js` so the
open-from-disk copy matches.
