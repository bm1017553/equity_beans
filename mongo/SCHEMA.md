# Equity Beans: MongoDB data model

Database **`equity_beans`**. Six collections, with every field's name and BSON type declared
before anything connects to a database.

The website reads and writes these collections through `server.js`, a Node/Express API. Create the
collections with the scripts below first, then start the server. See
[Running the site with the database](#running-the-site-with-the-database).

| Collection    | One document is                   | Sample documents live in                                                                 |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `products`    | A coffee sold on the site         | [`../data/products.json`](../data/products.json) (17 coffees, the file the site reads)   |
| `reviews`     | One customer review of one coffee | [`../data/reviews.json`](../data/reviews.json) (3 seed reviews, the file the site reads) |
| `users`       | A customer account                | Inline in `create-users.js`                                                              |
| `orders`      | A completed checkout              | Inline in `create-orders.js`                                                             |
| `quizResults` | One run through the coffee quiz   | Inline in `create-quizResults.js`                                                        |
| `messages`    | A message from the contact page   | Inline in `create-messages.js`                                                           |

`products` and `reviews` keep their samples in `data/` because those two files are also the site's
offline copy: opened straight from disk, with no server, the pages still show the coffees and seed
reviews (read-only) from `data/fallback.js`. `users`, `orders`, `quizResults` and `messages` have no
disk equivalent, so their samples live in the create scripts instead.

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
   `data/*.json`. For the other four, run the script in Option B or add documents by hand.

**Option B: `mongosh`** (run from the project folder)

```sh
mongosh "<your connection string>" mongo/create-products.js
mongosh "<your connection string>" mongo/create-reviews.js
mongosh "<your connection string>" mongo/create-users.js
mongosh "<your connection string>" mongo/create-orders.js
mongosh "<your connection string>" mongo/create-quizResults.js
mongosh "<your connection string>" mongo/create-messages.js
```

Each script drops and recreates its collection, so re-running one starts fresh. Order doesn't
matter: the collections reference each other by value, not by database constraint.

## Conventions used across every collection

These four decisions were made once and applied everywhere, so the collections agree with each
other and with the JavaScript.

**1. Dates: calendar days are strings, timestamps are BSON dates.**

| Kind                       | Type                | Fields                                                                                                  | Why                                                                                                                                                        |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A day a person picked      | string `YYYY-MM-DD` | `reviews.date`, `products.addedAt`                                                                      | `localDateString()` in `app.js` deliberately avoids `toISOString()`, which is already tomorrow on a US evening. These strings also sort correctly as text. |
| A moment the code recorded | BSON `date`         | `orders.createdAt`, `quizResults.takenAt`, `users.createdAt`, `users.lastLoginAt`, `messages.createdAt` | Real dates allow `$dateTrunc`, date ranges, and "orders this month" aggregations. `create-orders.js` demonstrates one.                                     |

The pages still work with ISO strings, so `server.js` converts at the boundary — see
[the API boundary](#the-conversion-at-the-api-boundary) below.

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

`users._id` is the exception: `orders.userId`, `quizResults.userId`, `reviews.userId` and
`messages.userId` reference a real `objectId`, or hold `null` for guest checkout, logged-out quiz
runs, the seed reviews and messages sent while logged out. `null` is used rather than omitting the
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
| `addedAt`             | string `YYYY-MM-DD`                  | string             | Home page's featured coffees show the newest arrivals                 |
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
- **Date strings:** `addedAt` is `2026-08-01` for the original coffee (`1001`), `2026-10-03` for the
  catalog expansion (`1002`–`1014`), and `2026-10-17` for the East African coffees (`1015`–`1017`).

---

## `reviews`

One document per review: the three seed reviews from
[`../data/reviews.json`](../data/reviews.json) plus every review customers write on `reviews.html`.

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

**Comment length:** the validator caps `comment` at 1000 characters, and the review box on
`reviews.html` has the same `maxlength="1000"`, with a "0 / 1000 characters" counter. The form can't
accept text the database would reject.

**Reviews belong to accounts.** Only a logged-in customer can write one, and the server sets
`userId` from the session, never from what the browser sends. `name` stays as the name shown on the
review: the username at the time it was written, kept as written the same way an order keeps its
item names. The three seed reviews have `userId: null`, since no account wrote them.

---

## `users`

One document per customer account. The sign-up form on `login.html` (**Create an account**)
collects a username, a password and two security questions with their answers. Email is collected
at checkout instead, and lives on `orders.customer.email`.

**Accounts live on the server.** `POST /api/signup` inserts
`{ username, passwordHash, role: "customer", securityQuestions, createdAt, lastLoginAt }` and `POST /api/login`
checks the password against `passwordHash` and updates `lastLoginAt`. The rules match the
validator: usernames use `USERNAME_PATTERN` (the same regex as below) and must be unique ignoring
case, passwords need at least 8 characters, and the two questions must be different ones from the
list, with answers of 2–100 characters.

`securityQuestions` is optional in the validator because accounts made before sign-up asked for
them don't have any. Those accounts can add them under **Security questions** on `account.html`;
changing them takes the current password.

**Roles.** Every account made on the site is a `customer`. An `admin` can only be made in the
database, so nobody can sign themselves up as one: create the account on `login.html`, then in
`mongosh` run `db.users.updateOne({ username: "admin" }, { $set: { role: "admin" } })`.

Admins get an **Admin** link in the header. It opens the **admin app**, an Angular app served at
`/admin/` (source in `admin-app/`, built into `admin/`; see the README). `admin.html` forwards there,
so old links still work. It has five tabs:

- **Orders**: every order (guest or account) with its shipping details, and a status menu
  (awaiting payment, paid, shipped, cancelled).
- **Messages**: every contact-page message, a status menu (new, answered, closed) and a reply link.
- **Products**: in stock for each coffee, and per purchase option whether it's available and its
  sale price. Regular prices and names are left to the database.
- **Users**: a tool for fixing the users collection, below.
- **Database**: each collection's document count, whether it has validation rules, and its indexes.
  Read-only.

**How the admin app reaches MongoDB.** Through the server, like every other page: the Angular app
calls `/api/admin/…`, and `server.js` reads and writes MongoDB. A browser can't safely hold database
credentials, so it never connects to MongoDB itself. Every change still goes through the
collection's validation rules.

**Fixing the users collection (Users tab).** Each account shows its role, logins, order count, and
a list of **problems**, worked out by the server (`toAdminUser()` in `server.js`):

| Problem | Found by | Fix |
| ------- | -------- | --- |
| Breaks the validation rules | A `$nor` query with the collection's own validator, e.g. a document saved before `role` was required | Fix the other problems; MongoDB refuses other changes to it until then |
| No role | `role` missing or not `customer`/`admin` | **Change role** |
| Password can't log in | `passwordHash` isn't a PBKDF2 hash this server can check, e.g. `create-users.js`'s placeholders | **Set temporary password** (or Generate one) |
| No security questions | `securityQuestions` missing | Only the customer can add them, on their account page |
| Login or reset locked | `loginLockedUntil` / `resetLockedUntil` in the future | **Unlock** |

The other fixes are **Rename** (unique ignoring case; their reviews follow the new name),
**Clear security questions**, and **Delete account**, which keeps the account's orders, reviews,
quiz results and messages as guest records (`userId: null`). Setting a password, renaming or
deleting ends that account's other logins. An admin can't change their own role or delete their
own account, so there's always at least one admin. Passwords and answers are never shown.

Customers like `testuser` who open `/admin/` see "Only admins can see this page." The real check is
on the server: every `/api/admin/…` route reads the role from the database on each request
(`requireAdmin()` in `server.js`), so a customer gets 403, a guest 401, and taking away someone's
admin role works straight away. `/api/session` also reads the role from the database, so the
header's Admin link follows a role change on the next page.

The sample users in `create-users.js` have placeholder hashes, so nobody can log in as them. To try
the site, use the accounts in `AI_Use_Stmt+Reasoning/Test_Account.docx` or create a new one on
`login.html`.

**Indexes:** `username` (unique, **case-insensitive**: collation `{ locale: "en", strength: 2 }`).
Login looks an account up by it, and "Maria" and "maria" must never be two accounts. A query only
uses this index if it passes the same collation; `create-users.js` shows the lookup.

| Field                            | BSON type           | JavaScript type    | Used on the site for                                                 |
| -------------------------------- | ------------------- | ------------------ | -------------------------------------------------------------------- |
| `_id`                            | objectId            | (added by MongoDB) | Referenced by `userId` in `orders`, `quizResults` and `reviews`      |
| `username`                       | string (3–30 chars) | string             | Chosen at sign-up, typed at login (case-insensitive unique)          |
| `passwordHash`                   | string (a hash)     | string             | Login check. With a server, **never sent to the browser**            |
| `role`                           | string (one of 2)   | string             | `customer` (every sign-up) or `admin`; the account page labels admins |
| `securityQuestions`              | array of 2, optional | —                 | "Forgot password?": the two questions and their hashed answers        |
| `securityQuestions.questionId`   | string (one of 8)   | —                  | Which question, by id; `SECURITY_QUESTIONS` in `server.js` has the wording |
| `securityQuestions.answerHash`   | string (a hash)     | —                  | The answer, hashed like a password; **never sent to the browser**    |
| `loginFailures`                  | int, optional       | —                  | Wrong passwords since the last lock or successful login              |
| `loginLockedUntil`               | date, optional      | —                  | While in the future, logging in is refused, even with the right password |
| `resetFailures`                  | int, optional       | —                  | Wrong answers since the last lock or successful reset                |
| `resetLockedUntil`               | date, optional      | —                  | While in the future, "Forgot password?" refuses this account         |
| `createdAt`                      | **date**            | Date               | Account age                                                          |
| `lastLoginAt`                    | **date or null**    | Date / `null`      | Latest login; sign-up counts as the first, since it logs you in      |

### How "Forgot password?" works

`password-reset.html` asks for a username and shows that account's two questions
(`POST /api/password/questions`). Answering both and choosing a new password
(`POST /api/password/reset`) sets the new password and logs in.

- **Answers are compared loosely and stored like passwords.** Before hashing or checking, an
  answer is lower-cased, trimmed, and its spaces tidied, so "Fluffy" and " fluffy " match. The
  result is hashed with the same PBKDF2 as passwords. Answers are short and guessable, so a slow
  hash matters even more for them: a stolen database shouldn't give them away.
- **The form doesn't reveal which usernames exist.** A username with no account still gets two
  questions. They're picked from the username with the session secret (an HMAC), so they're the
  same every time and look like a real account's. Both answers are always checked, against
  stand-in hashes when there's no account, and every wrong case gets the same message, so neither
  the reply nor its timing shows whether the account exists or which answer was wrong.
- **Guessing is limited.** After 5 wrong tries, `resetLockedUntil` is set an hour ahead and the
  account can't be reset until then; logging in with the password still works. A successful
  reset, new questions saved on the account page, or an admin's Unlock clears it. (The lock is the
  one thing that shows a username is real, and only after 5 wrong tries.)
- **A reset logs the account out everywhere else** by deleting its documents from `sessions`, in
  case someone else knew the old password. It also ends a login lock (below), since answering the
  questions proves it's the owner.

### Locks on guessing

Wrong guesses are counted per account, and too many in a row lock that action for a while:

| Action                    | Locks after          | For        | Count and lock fields                  | Ended early by                                 |
| ------------------------- | -------------------- | ---------- | -------------------------------------- | ---------------------------------------------- |
| Logging in                | 10 wrong passwords   | 15 minutes | `loginFailures`, `loginLockedUntil`    | A password reset, or an admin's Unlock         |
| "Forgot password?"        | 5 wrong answer pairs | 1 hour     | `resetFailures`, `resetLockedUntil`    | New security questions, or an admin's Unlock   |

- A locked login is refused **even with the right password**, so guessing stays useless during the
  lock. Browsers that are already logged in stay logged in.
- The "current password" box on the account page (changing the password or security questions)
  counts toward the login lock too, so a borrowed logged-in browser can't be used to guess it.
- Counts go up with an atomic `$inc`, so guesses sent at the same moment can't get past the limit.
  A successful login sets `loginFailures` back to 0.
- `LOCKS` in `server.js` holds the numbers; `recordFailure()`, `lockedUntil()` and `clearLock()` are
  shared by both kinds.
- Unknown usernames aren't counted (there's no document to count on), so a lock message shows that
  an account exists, but only after 10 wrong passwords.
- Someone can lock another person's login on purpose by guessing wrong 10 times. That only lasts 15
  minutes, the owner can end it with their security questions, and an admin can unlock it.

### Changing the password

The **Password** section of `account.html` takes the current password and a new one
(`POST /api/me/password`). The new one must be at least 8 characters and different from the current
one. Every other browser logged in to the account is logged out (its `sessions` documents are
deleted); the one making the change stays in.
- **The questions are stored by id**, not wording, so a question can be reworded without breaking
  anyone's answers. The ids are the `enum` in `users.validator.json`.

Security questions are weaker than an emailed link, because some answers can be guessed or found
out. The list avoids questions with public answers (no mother's maiden name or birth city), and the
lock limits guessing, but customers should still pick answers others can't look up.

### How passwords are stored

`passwordHash` must start with a known hash format, enforced by the validator's `pattern`:

- `pbkdf2-sha256$<iterations>$<salt>$<hash>` — what the site writes. `hashPassword()` in
  `server.js` uses Node's built-in `crypto`: PBKDF2 with SHA-256, a random 16-byte salt, and
  600,000 iterations (OWASP's recommendation). The algorithm and cost are stored with the hash, so
  the cost can be raised later without breaking existing accounts.
- `$2b$…` (bcrypt) or `$argon2id$…` (argon2) — also accepted by the validator. They need native
  modules compiled for the machine, which is why the server uses PBKDF2 instead. Switching later
  would mean verifying a `pbkdf2-sha256` hash at the customer's next login and re-saving it, since
  a hash can't be converted without the password.

**The hash never leaves the server.** The browser sends the password over the request once, and
gets back only an httpOnly session cookie that page scripts can't read. No API response includes
`passwordHash` or `_id`.

### Two things this schema deliberately does not do

- **There is no `password` field, and never will be.** The field is `passwordHash`, and its pattern
  only accepts real hash formats, so a plain password is a validation error even if it's put in
  the right field by mistake. `create-users.js` demonstrates both rejections, and its sample hashes
  are obvious placeholders, not real hashes.
- **`loggedIn` is not stored.** Being logged in is _session_ state, not a fact about the account.
  It lives in the `sessions` collection (see below). The browser keeps only a copy of the username
  in `localStorage` so the header can draw before the server answers, and checks it on every page.

---

## `orders`

One document per completed checkout. `checkout.html` sends only the shipping details and each cart
line's `productId`, `option` and `qty`. The server looks up names and prices in `products`, checks
availability, and computes `totals`, `amountCents` and `orderId`, so an edited cart can't change
what an order costs.

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

One document per run through the coffee quiz, saved under the logged-in account or as a guest run
(`userId: null`). The shop sidebar, Home page and account page read the latest one for whoever is
browsing. Keeping every run is what makes the aggregations in `create-quizResults.js` possible.

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

## `messages`

One document per message sent from the contact page (`contact.html`). The page sends the form
fields; the server adds `userId`, `status: "new"` and `createdAt`.

**Indexes:** `status + createdAt` descending for a support inbox (new messages first);
`userId + createdAt` descending for one customer's messages.

| Field       | BSON type            | JavaScript type    | Used on the site for                                                 |
| ----------- | -------------------- | ------------------ | -------------------------------------------------------------------- |
| `_id`       | objectId             | (added by MongoDB) | Internal document ID                                                 |
| `userId`    | objectId **or null** | —                  | The account that sent it, or `null` when logged out                  |
| `name`      | string (2–80)        | string             | Name field; the confirmation says "Thanks, {first name}"             |
| `email`     | string (email)       | string             | Where to reply; same pattern as the form and checkout                |
| `topic`     | string (one of 5)    | string             | Topic dropdown: `order`, `coffee`, `account`, `feedback`, `other`    |
| `orderId`   | string **or null**   | string / `null`    | Only for order questions: the `EB-…` number, else `null`             |
| `message`   | string (10–1000)     | string             | Message box, with the same `maxlength` and counter as reviews        |
| `status`    | string (one of 3)    | string             | Starts `new`; staff move it to `answered`, then `closed`             |
| `createdAt` | **date**             | Date               | Inbox order                                                          |

`orderId` points at `orders.orderId` (the number customers see) rather than an order's `_id`, for
the same reason products are joined by `id`: it's what the customer actually types or picks.
Logged-in customers choose from a list of their own orders; guests can type the number. `status`
isn't shown on the site yet, but a support inbox can't work without it, so it's stored from the
first message rather than added later.

---

## The conversion at the API boundary

The pages and the collections almost agree, but not exactly. `server.js` converts between them, so
the pages never see a BSON type or an account ID:

| The pages use                                                | The collection stores   | Where `server.js` converts                                           |
| ------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------- |
| ISO date strings: `createdAt` (orders), `takenAt` (quiz)     | BSON `date`             | The server sets these with `new Date()`; responses use `toISOString()` |
| `username: "maria"` or `null` (orders, quiz results)         | `userId`: objectId/null | `userId` comes from the session; responses swap it for the username  |
| No `_id`, `userId`, `passwordHash` or answer hashes         | All of them             | Stripped from every response                                         |

Logging in also moves that visit's guest quiz runs and orders to the account: the session remembers
their `_id`s, and login sets `userId` on them (`startSession()` in `server.js`).

This is a feature of declaring the types up front: the mismatch showed up in a table, instead of
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

## Running the site with the database

With MongoDB running and the six collections created (above), from the project folder:

```sh
npm install                 # first time only
cp .env.example .env        # first time only; then set SESSION_SECRET in .env
npm start                   # http://localhost:3000
```

`MONGODB_URI` in `.env` defaults to `mongodb://localhost:27017`. Without a `SESSION_SECRET`, the
server makes a new one each start, which logs everyone out.

The pages call the API only through functions in `app.js` (`getProducts()`, `getReviews()`,
`logIn()`, `saveOrder()` and so on), all of which go through one `api()` helper.

| Method + path                    | Who        | Does                                                                                     |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| GET `/api/products`              | anyone     | Every coffee                                                                             |
| GET `/api/reviews?productId=`    | anyone     | Reviews, newest first (all coffees if `productId` is left out)                           |
| POST `/api/reviews`              | logged in  | `{ productId, rating, comment, date }`                                                   |
| GET `/api/me/reviews`            | logged in  | The account's own reviews                                                                |
| GET `/api/session`               | anyone     | `{ username, role }`, both `null` when logged out                                        |
| POST `/api/signup`               | anyone     | `{ username, password, securityQuestions: [{ questionId, answer } ×2] }` → `{ username, claimed }` |
| POST `/api/login`                | anyone     | `{ username, password }` → `{ username, claimed: { orders, quizzes } }`                  |
| POST `/api/logout`               | anyone     | Ends the session                                                                         |
| GET `/api/me`                    | logged in  | `{ username, role, securityQuestions }`: questions' wording, or `null` if not set up |
| POST `/api/me/security-questions` | logged in | `{ securityQuestions, password }`: adds or changes them; needs the current password     |
| POST `/api/me/password`          | logged in  | `{ currentPassword, newPassword }`: logs out other devices; wrong guesses count toward the login lock |
| GET `/api/security-questions`    | anyone     | The questions to choose from: `[{ id, question }]`                                       |
| POST `/api/password/questions`   | anyone     | `{ username }` → `{ questions }`: the account's two questions (decoys if no account)   |
| POST `/api/password/reset`       | anyone     | `{ username, answers: [a, b], password }`: checks both answers, sets the password, logs in |
| POST `/api/orders`               | anyone     | `{ customer, items: [{ productId, option, qty }] }`; the server prices it                 |
| GET `/api/orders`                | logged in  | The account's orders, newest first                                                       |
| POST `/api/quiz-results`         | anyone     | `{ productIds }`, best match first                                                       |
| GET `/api/quiz-results/latest`   | anyone     | The latest run for this account, or for this guest session                               |
| POST `/api/messages`             | anyone     | `{ name, email, topic, orderId, message }`                                               |
| GET `/api/admin/orders`, `/messages`, `/users` | admin | Everything in that collection for the admin app; users with their `problems`, never any hashes |
| POST `/api/admin/orders/:orderId/status` | admin | `{ status }`: one of the orders validator's statuses |
| POST `/api/admin/messages/:id/status` | admin | `{ status }`: `new`, `answered` or `closed` (`:id` is the message's `_id`) |
| POST `/api/admin/products/:id` | admin | `{ inStock, options: [{ name, available, salePrice }] }`; sale price below the regular price, or `null` |
| POST `/api/admin/users/:username/unlock` | admin | Clears the account's login and reset locks and their counts |
| POST `/api/admin/users/:username/role` | admin | `{ role }`: `customer` or `admin`; not on your own account |
| POST `/api/admin/users/:username/rename` | admin | `{ newUsername }`: unique ignoring case; their reviews follow; their other logins end |
| POST `/api/admin/users/:username/password` | admin | `{ password }`: a temporary password; ends all their logins and clears the login lock |
| POST `/api/admin/users/:username/clear-questions` | admin | Removes their security questions, so they set new ones |
| POST `/api/admin/users/:username/delete` | admin | Deletes the account; its orders, reviews, quiz results and messages stay as guest records |
| GET `/api/admin/database` | admin | Each collection's document count, validation rules and indexes (read-only) |

**Sessions.** Logging in sets an httpOnly, `SameSite=Lax` cookie called `eb.sid`, valid for 30 days.
Sessions are stored by `connect-mongo` in one more collection, `sessions`, which it creates and
cleans up by itself (expired sessions are removed by a TTL index). It has no validator because
`server.js` never writes to it directly; it only deletes an account's sessions after a password
reset. API writes must be sent as JSON, which an ordinary form on
another site can't do.

**What's public.** The server serves only the pages, `styles.css`, `app.js`, images and `data/`.
`server.js`, `package.json`, `.env`, `mongo/`, `admin-app/` (the Angular source) and `node_modules/` return 404. `admin/` (the built Angular app) is public, but its data comes only from the admin routes.

**Without the server.** Opening a page straight from disk still shows the coffees and seed reviews
from `data/fallback.js`. Logging in, reviewing, checking out, saving a quiz and sending a message
show "This needs the Equity Beans server." If you edit `data/products.json`, run
`node data/build-fallback.js` so the open-from-disk copy matches.
