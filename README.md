# PonyPals Party Rides

Website for a local mobile pony ride business. Runs on plain Node.js with no npm dependencies. Parents can browse the ponies and prices, then send a party request straight from the page.

## Run it

```bash
ADMIN_PASSWORD=choose-a-strong-password node server.js     # or: npm start
```

You can also put `ADMIN_PASSWORD` (and optional `ADMIN_USER`, `ADMIN_SESSION_SECRET`, `HOST`, `PORT`) in a local `.env` file (ignored by git).

- Server binds to `127.0.0.1:3000` by default (ready to sit behind a reverse proxy like Nginx or Caddy). Override with `HOST` / `PORT` if needed.
- Website: http://127.0.0.1:3000
- Owner portal (incoming requests): http://127.0.0.1:3000/admin

```bash
npm test           # runs against a temp copy of the data, never the real bookings
```

## What's on the site

- **Request form**: package, date/time, address, birthday kid, pony preferences, extras, and a free-text "Tell us about your party" box. Shows a running price estimate and a confirmation with a reference number after sending.
- **Owner portal** (`/admin`): protected by sign-in (`ADMIN_USER` defaults to `admin`, `ADMIN_PASSWORD` is required; fails closed with `503` if unset). Lists requests with contact info and notes, status changes (Pending / Confirmed / Completed / Cancelled), delete, and simple totals.
- Pony profiles, a price table, how-it-works steps, safety notes, reviews, and an FAQ.

## Before going live

- **Photos**: add real photos to `public/images/` (see `public/images/README.txt` for file names). Until then each slot shows a solid color panel.
- **Reviews**: the quotes in the "From parents" section are placeholders. Replace them with real ones.
- **Contact details**: phone number, email, service area, and prices are sample values.
- **Admin credentials**: set a strong `ADMIN_PASSWORD` (and optionally `ADMIN_SESSION_SECRET`) in the environment or `.env` on the server, and terminate HTTPS at your reverse proxy.

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

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/ponies` | Pony profiles | Public |
| GET | `/api/packages` | Packages and extras | Public |
| POST | `/api/requests` | Submit a request (validated server-side) | Public |
| POST | `/api/admin/login` | Sign in to owner portal (sets `HttpOnly` session cookie) | Credentials |
| POST | `/api/admin/logout` | Sign out of owner portal | Session |
| GET | `/api/requests` | All requests, newest first | Owner |
| PATCH | `/api/requests/:id` | Update status | Owner |
| DELETE | `/api/requests/:id` | Remove a request | Owner |
| GET | `/api/stats` | Counts and confirmed revenue | Owner |
