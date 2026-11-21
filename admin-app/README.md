# Equity Beans admin app (Angular)

The admin pages, served by the Express server at `http://localhost:3000/admin/`. The main
[README](../README.md) covers running the site; this folder is only needed to change the admin app.

## Build

From the project folder (one level up):

```sh
npm run setup:admin   # once: installs Angular here
npm run build:admin   # builds this app into ../admin, which the server serves
```

Then reload `/admin/`. Building needs Node.js 22.22.3+ or 24.15+. `ng serve` isn't used: the app
calls the server's `/api/admin/…` routes and needs its login cookie, so it's always opened through
`npm start`.

## Layout (`src/app/`)

| File | What it does |
| ---- | ------------ |
| `app.ts`, `app.html` | The page around the tabs: the site header, the tab bar with counts, the admin check |
| `app.routes.ts` | One route per tab (`#/orders`, `#/messages`, `#/products`, `#/users`, `#/database`) |
| `admin-api.ts` | The service that calls the server, and the types of what it returns |
| `admin-store.ts` | The lists the tabs share, as signals, updated after every save |
| `session.ts`, `auth.interceptor.ts` | Who's logged in; reacting once to a lost login (401) or role (403) |
| `pages/*.ts`, `pages/*.html` | One component per tab |
| `labels.ts`, `notes.ts` | Display names for stored values; the "Saved" message beside a control |

The app never connects to MongoDB itself; every read and change goes through `server.js`, which
checks the admin role in the database on each request. It uses the site's own `/styles.css`, plus
`src/styles.css` for the admin-only parts.
