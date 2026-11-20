# PonyPals757

Website for PonyPals757 in Hampton, Virginia. Runs on plain Node.js with no npm dependencies. Customers can browse packages, view photos, and send a booking request straight from the page.

## Run it

```bash
ADMIN_PASSWORD=choose-a-strong-password node server.js     # or: npm start
```

You can also put `ADMIN_PASSWORD` (and optional `ADMIN_USER`, `ADMIN_SESSION_SECRET`, `HOST`, `PORT`, `PONYPALS_REQUESTS_FILE`) in a local `.env` file (ignored by git).

- Server binds to `127.0.0.1:3000` by default (ready to sit behind a reverse proxy like Nginx or Caddy). Override with `HOST` / `PORT` if needed.
- Website: http://127.0.0.1:3000
- Photos page: http://127.0.0.1:3000/photos
- Owner portal (incoming requests): http://127.0.0.1:3000/admin

```bash
npm test           # runs against a temp copy of the data, never the real bookings
```

## What's on the site

- **Packages & request form**: Pony Party, Lesson, Pony Play Date, Pony Ride, and Pony Rental for Photos, with date/time, client-decided location notes, and confirmation reference numbers.
- **Photos page** (`/photos`): automatically lists any image files placed in `public/images/` (excluding `logo.*`).
- **Custom logo**: drop `logo.png` (or `.svg`, `.webp`, `.jpg`, `.jpeg`) into `public/images/` to replace the default horseshoe icon across the site.
- **Owner portal** (`/admin`): protected by sign-in (`ADMIN_USER` defaults to `admin`, `ADMIN_PASSWORD` is required; fails closed with `503` if unset). Lists requests with contact info and notes, status changes (Pending / Confirmed / Completed / Cancelled), delete, and simple totals.

## Project layout

```
server.js            HTTP server + JSON API (node:http, no framework)
data/
  packages.json      packages and prices
  ponies.json        optional pony profiles
  requests.json      submitted booking requests
public/
  index.html         customer site + request form
  photos.html        photos gallery page (/photos)
  admin.html         owner portal (/admin)
  css/style.css
  js/app.js          form, running total, submission
  js/photos.js       gallery loader
  js/admin.js        request list, status updates
  images/            drop photos and optional logo.* here
tests/test-app.js
```

## API

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/packages` | Packages | Public |
| GET | `/api/photos` | Gallery image list from `public/images/` | Public |
| GET | `/logo` | Custom logo file if present in `public/images/` | Public |
| POST | `/api/requests` | Submit a request (validated server-side) | Public |
| POST | `/api/admin/login` | Sign in to owner portal (sets `HttpOnly` session cookie) | Credentials |
| POST | `/api/admin/logout` | Sign out of owner portal | Session |
| GET | `/api/requests` | All requests, newest first | Owner |
| PATCH | `/api/requests/:id` | Update status | Owner |
| DELETE | `/api/requests/:id` | Remove a request | Owner |
| GET | `/api/stats` | Counts and confirmed revenue | Owner |
