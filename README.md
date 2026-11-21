# Equity Beans

A Fair Trade coffee shop website. The shop's pages are HTML, CSS and JavaScript; the admin pages
are an Angular app. `server.js` is a Node.js/Express server that serves both and stores accounts,
orders, reviews, quiz results and contact messages in MongoDB.

## What you need

| Software                     | Version                    | Used for                                      | Download                                                  |
| ---------------------------- | -------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Node.js (includes npm)       | 22.9 or newer (24 LTS recommended) | Running the server and installing packages    | https://nodejs.org                                        |
| MongoDB Community Server     | 6.0 or newer (built with 9.0) | The database                                  | https://www.mongodb.com/try/download/community            |
| MongoDB Shell (`mongosh`)    | 2.x                        | Creating the database's collections           | https://www.mongodb.com/try/download/shell                |

Check they're installed by opening a terminal and running:

```sh
node --version
npm --version
mongosh --version
```

MongoDB must be **running** on this computer at `mongodb://localhost:27017` (its default address).
On Windows the installer sets it up as a service that starts automatically. Elsewhere, start it with
`brew services start mongodb-community` (macOS) or `sudo systemctl start mongod` (Linux).

## Installation

Run every command from the project folder (the one that contains `package.json`). The database
scripts read files by relative paths, so they won't work from anywhere else.

### 1. Install the dependencies

```sh
npm install
```

This downloads the packages listed in `package.json` into `node_modules/`: Express (web server),
the official MongoDB driver, express-session and connect-mongo (login sessions), and type-is.

### 2. Create the settings file (recommended)

Copy the example settings file to `.env`:

```sh
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Then open `.env` and set `SESSION_SECRET` to a long random string. This command prints one to copy
in:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The settings are:

| Setting          | Default                       | Meaning                                                        |
| ---------------- | ----------------------------- | -------------------------------------------------------------- |
| `MONGODB_URI`    | `mongodb://localhost:27017`   | Where MongoDB is running. The database is always `equity_beans`. |
| `SESSION_SECRET` | (none)                        | Signs the login cookie. Without it, a new one is made each time the server starts, which logs everyone out. |
| `PORT`           | `3000`                        | The port the website runs on.                                  |

The site still starts without a `.env` file; it uses the defaults and prints a warning.

### 3. Create the database

Run these six scripts once. Each creates one collection in the `equity_beans` database, with its
validation rules, indexes and sample data:

```sh
mongosh "mongodb://localhost:27017" mongo/create-products.js
mongosh "mongodb://localhost:27017" mongo/create-reviews.js
mongosh "mongodb://localhost:27017" mongo/create-users.js
mongosh "mongodb://localhost:27017" mongo/create-orders.js
mongosh "mongodb://localhost:27017" mongo/create-quizResults.js
mongosh "mongodb://localhost:27017" mongo/create-messages.js
```

Each script prints what it created, then shows some invalid documents being refused. Lines such as
"Rejected as expected" are part of that check, not errors.

**Running a script again deletes that collection and starts it fresh.** Running `create-users.js`
again, for example, deletes every account. `mongo/SCHEMA.md` explains each collection. It also shows
how to create them in MongoDB Compass instead of `mongosh`.

## Starting the application

```sh
npm start
```

When it's ready, the terminal shows:

```
Equity Beans is running at http://localhost:3000
```

Open **http://localhost:3000** in a web browser. To stop the server, press **Ctrl+C** in the
terminal.

## The admin app (Angular)

Logged in as an admin, the header's **Admin** link opens **http://localhost:3000/admin/**. It's an
Angular app for managing orders, contact messages, coffees and accounts (including fixing problem
accounts in the users collection), plus a read-only overview of the database.

The app comes **already built** in `admin/`, so `npm start` serves it with nothing else to do. Its
source is in `admin-app/`. To change it, rebuild it afterwards:

```sh
npm run setup:admin   # once: installs Angular into admin-app/node_modules
npm run build:admin   # builds admin-app/ into admin/
```

Then reload the admin page; the server doesn't need restarting. Building needs Node.js **22.22.3+
or 24.15+** (Angular 22's requirement), newer than what running the site needs.

## Test accounts

`AI_Use_Stmt+Reasoning/Test_Account.docx` lists the two test accounts, `admin` and `testuser`. It
also covers what each page does and what to try.

Those accounts live in the database they were made in. On a fresh installation, `create-users.js`
adds only sample users with placeholder passwords, which can't log in. To make the test accounts:

1. On the site, choose **Log in**, then **Create an account**. Make `testuser` with password
   `Buffs123` and `admin` with password `admin123`. Pick any two security questions for each, and
   note your answers.
2. Make `admin` an administrator. Every new account is a customer, and the site never lets anyone
   sign up as an admin:

   ```sh
   mongosh "mongodb://localhost:27017/equity_beans" --eval 'db.users.updateOne({ username: "admin" }, { $set: { role: "admin" } })'
   ```

   In Windows PowerShell, use `--eval "db.users.updateOne({ username: 'admin' }, { `$set: { role: 'admin' } })"`
   instead. Reload any page while logged in as `admin`, and the header shows an **Admin** link.

## Troubleshooting

| Problem                                                     | Fix                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Could not connect to MongoDB at mongodb://localhost:27017` | MongoDB isn't running. Start it (see "What you need") and run `npm start` again.                              |
| `npm start` says `bad option: --env-file-if-exists`         | Node.js is older than 22.9. Install a newer version from https://nodejs.org.                                   |
| `EADDRINUSE` / port 3000 is already in use                  | Another program is using port 3000. Stop it, or set `PORT=3001` in `.env` and open http://localhost:3001.       |
| A `create-*.js` script fails with `ENOENT` (file not found)  | It was run from the wrong folder. Change to the project folder and run it again.                              |
| The shop shows no coffees                                   | The database hasn't been created. Run the six scripts in step 3, then reload the page.                         |
| Opened an HTML file directly and can't log in               | Pages opened from the folder show the coffees and reviews, but logging in, checking out and saving need the server. Use http://localhost:3000. |

## Project layout

| Path                     | What it is                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `server.js`              | The Express server: serves the pages and the JSON API under `/api/`        |
| `*.html`, `styles.css`, `app.js` | The website's pages, styles and shared browser code                 |
| `admin-app/`             | The Angular admin app's source (components, a service for the API, routing) |
| `admin/`                 | The built admin app that the server serves at `/admin/` (made by `npm run build:admin`) |
| `data/`                  | The coffee and seed review data, and an offline copy for pages opened from disk |
| `mongo/`                 | Database scripts, validation rules (`*.validator.json`) and `SCHEMA.md`     |
| `.env.example`           | The settings template for `.env`                                           |
| `AI_Use_Stmt+Reasoning/` | Assignment write-ups, including `Test_Account.docx`                        |
