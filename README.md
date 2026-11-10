# PonyPals Party Rides

Website for a local mobile pony ride business. Runs on plain Node.js with no npm dependencies. Parents can browse the ponies and prices, then send a party request straight from the page.

## Run it

```bash
node server.js     # or: npm start
```

- Website: http://localhost:3000
- Owner portal (incoming requests): http://localhost:3000/admin

```bash
npm test           # runs against a temp copy of the data, never the real bookings
```

## What's on the site

- **Request form**: package, date/time, address, birthday kid, pony preferences, extras, and a free-text "Tell us about your party" box. Shows a running price estimate and a confirmation with a reference number after sending.
- **Owner portal** (`/admin`): list of requests with contact info and notes, status changes (Pending / Confirmed / Completed / Cancelled), delete, and simple totals.
- Pony profiles, a price table, how-it-works steps, safety notes, reviews, and an FAQ.

## Before going live

- **Photos**: add real photos to `public/images/` (see `public/images/README.txt` for file names). Until then each slot shows a solid color panel.
- **Reviews**: the quotes in the "From parents" section are placeholders. Replace them with real ones.
- **Contact details**: phone number, email, service area, and prices are sample values.
- **Owner portal**: `/admin` has no login yet. Put it behind authentication before deploying publicly.

## Project layout

```
server.js            HTTP server + JSON API (node:http, no framework)
data/
  packages.json      packages, extras, prices
  ponies.json        pony profiles
  requests.json      submitted party requests
public/
  index.html         customer site + request form
  admin.html         owner portal
  css/style.css
  js/app.js          form, running total, submission
  js/admin.js        request list, status updates
  images/            drop real photos here
tests/test-app.js
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/ponies` | Pony profiles |
| GET | `/api/packages` | Packages and extras |
| GET | `/api/requests` | All requests, newest first |
| POST | `/api/requests` | Submit a request (validated server-side) |
| PATCH | `/api/requests/:id` | Update status |
| DELETE | `/api/requests/:id` | Remove a request |
| GET | `/api/stats` | Counts and confirmed revenue |
