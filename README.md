# Dentist Finder

Enter a US ZIP code, choose how many results you want and how far to look, and
the app returns nearby dentists with the contact details the data source has:
name, address, phone, email, website, coordinates and a map link. By default it
only returns practices that have a website.

Version 1 runs entirely on **free OpenStreetMap services** — no API key, no
billing account, no Google dependency. The application is built around a
provider abstraction, so moving to Google Places later is a configuration
change plus one file, not a rewrite.

```
Browser ──► /api/dentists ──► getDentistSearchProvider() ──► OSM provider ──► Nominatim + Overpass
                                        │
                                        └────────────────► Google provider ──► Places API   (later)
```

---

## Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Install and run](#install-and-run)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [Search flow](#search-flow)
- [Provider abstraction](#provider-abstraction)
- [The normalised Dentist model](#the-normalised-dentist-model)
- [OSM provider: Nominatim](#osm-provider-nominatim)
- [OSM provider: Overpass](#osm-provider-overpass)
- [Result ordering and de-duplication](#result-ordering-and-de-duplication)
- [Caching](#caching)
- [Rate limiting and responsible use](#rate-limiting-and-responsible-use)
- [Upstream reliability](#upstream-reliability)
- [Exports](#exports)
- [Verifying the Excel export](#verifying-the-excel-export)
- [Saving to Google Sheets](#saving-to-google-sheets)
- [PMS detection](#pms-detection)
- [Switching from OSM to Google](#switching-from-osm-to-google)
- [Attribution](#attribution)
- [Known limitations](#known-limitations)
- [Testing](#testing)
- [Future scale](#future-scale)

---

## What it does

| Input | Values |
| --- | --- |
| ZIP code | Any US ZIP; `12345` or `12345-6789` (the +4 suffix is trimmed before geocoding) |
| Results | 20, 30, 50, or **All (no limit)** (default 20) |
| Radius | 5, 10, 15, 25 or 50 km (default 15 km) |
| Website filter | On by default. Restricts results to practices that have a website. |

Results are shown nearest-first as a table on desktop (Dentist, Address, Phone,
Email, Website, Map, PMS) and as cards on mobile, 20 per page with a pager
underneath (shadcn/ui Pagination). Paging is for reading only: the exports, the
spreadsheet save and the PMS scan always cover every result. **Rating and Reviews columns appear
whenever the results carry them** — which today means under Google. The rule is
`hasRatings(dentists)`, a check on the data rather than on `dentist.source`, so
OSM searches never show two columns of dashes and a future provider gets the
columns the moment it populates the fields.

Results leave the page three ways — see [Exports](#exports). Searches are reflected in the URL
(`/?zip=92618&limit=20&radius=15000&requireWebsite=1`), so a search can be
refreshed, bookmarked or shared.

**Email coverage in OpenStreetMap is partial.** Roughly a third of the dentists
that have a website also have an `email` or `contact:email` tag (measured: 15 of
50 for ZIP 90210, 8 of 23 for 60601), so the column is often `—`. It is read from
the source and never guessed at — no address is constructed from a domain name
and no `info@` is ever assumed. See [Known limitations](#known-limitations).

**Asking for 50 does not mean 50 exist.** If OpenStreetMap knows about 17
dentists inside the radius, the app says "17 dentists found". Results are never
padded, duplicated or invented.

**"All (no limit)" returns everything found in the radius**, however many that
is. It is safe to offer because the limit has never driven upstream cost: the
Overpass query is identical whatever the limit, and the complete result set for
a point and radius is fetched and cached either way — the limit only decides how
much of that cached list is returned. The real bound on work is the 50 km
maximum radius. Arbitrary numeric limits are still rejected: unlimited has to be
asked for by name (`limit=all`), so no client reaches it by guessing a big
enough number.

The website filter is applied **in the upstream query, not in the browser**, so
`limit` is spent entirely on results you can use: asking for 50 with the filter
on returns up to 50 dentists that all have a website, rather than 50 fetched and
then thinned out. Measured on ZIP 92618 at 5 km: 8 dentists unfiltered, 2 with
the filter on.

## Tech stack

- **Next.js 16** (App Router) with **React 19** and **TypeScript** in strict mode
- **Tailwind CSS v4**
- Native `fetch` and `AbortSignal` — no HTTP client dependency
- **Zero runtime dependencies.** The CSV and XLSX writers are both
  hand-written; see [Verifying the Excel export](#verifying-the-excel-export)
- **Vitest** for unit tests (the only added dependency, and a dev one)

There is no database. Version 1 does not need one: the only state worth keeping
is a short-lived cache, which lives in memory.

## Install and run

```bash
npm install
cp .env.example .env.local   # optional: the defaults already work
npm run dev                  # http://localhost:3000
```

Other scripts:

```bash
npm run build   # production build (also type-checks)
npm run start   # serve the production build
npm run lint    # ESLint
npm test        # Vitest unit tests
```

`.env.local` is optional — with no environment at all the app defaults to the
OSM provider against the public endpoints. Before deploying anything public,
please set `OSM_USER_AGENT` to include your own contact address (see below).

## Environment variables

All configuration is read in exactly one place, [`lib/config.ts`](lib/config.ts),
validated there, and exposed as a typed object. No other module touches
`process.env`. Everything is server-side only; nothing here is prefixed
`NEXT_PUBLIC_`, so no key can leak into the browser bundle.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAP_PROVIDER` | `osm` | `osm` or `google`. Selects the implementation. |
| `OSM_USER_AGENT` | `DentistFinder/1.0 (…)` | Sent to Nominatim and Overpass. Nominatim requires an identifying, application-specific value; add your contact address. |
| `NOMINATIM_BASE_URL` | `https://nominatim.openstreetmap.org` | Point at your own instance if you run one. |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Point at your own instance if you run one. Accepts a **comma-separated list** in preference order; later entries are tried only when an earlier one cannot be reached (see [Upstream reliability](#upstream-reliability)). |
| `GOOGLE_MAPS_API_KEY` | _unset_ | Required only when `MAP_PROVIDER=google`. |
| `SHEETS_SPREADSHEET_ID` | _unset_ | Optional. The spreadsheet to append to; the id from its URL. |
| `SHEETS_CLIENT_EMAIL` | _unset_ | Optional. Service-account address. The sheet must be shared with it as an Editor. |
| `SHEETS_PRIVATE_KEY` | _unset_ | Optional. The service account's PEM key. **A credential** — newlines written as `
`. |

The three `SHEETS_*` variables are required **together or not at all**; see
[Saving to Google Sheets](#saving-to-google-sheets). Unset, the app runs
normally and the button is not rendered.

Configuration is validated at first use and fails loudly rather than silently
misbehaving:

```
MAP_PROVIDER=google without a key
  → "Google provider selected but GOOGLE_MAPS_API_KEY is not configured."

MAP_PROVIDER=yelp
  → "Unknown MAP_PROVIDER "yelp". Supported values: osm, google."

OVERPASS_URL=not-a-url
  → "OVERPASS_URL is not a valid URL: "not-a-url""

SHEETS_SPREADSHEET_ID set, the other two missing
  → "Google Sheets integration is partly configured. SHEETS_SPREADSHEET_ID,
     SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY are all required, or all
     omitted."
```

`.env`, `.env.local` and `.env.*.local` are git-ignored; `.env.example` is
deliberately un-ignored and contains no secrets.

## Project structure

```
app/
├── api/dentists/route.ts     GET /api/dentists — validate, call provider, serialise
├── api/dentists/save/route.ts POST — re-run the search, upsert into the sheet
├── layout.tsx
├── page.tsx                  Server Component: reads the URL, renders the shell
└── globals.css

components/
├── DentistFinder.tsx         Client container: request lifecycle and page state
├── DentistSearchForm.tsx     ZIP / count / radius / submit + validation UI
├── DentistResults.tsx        Summary line, the three exports, layout selection
├── DentistTable.tsx          Desktop presentation
├── DentistCard.tsx           Mobile presentation
├── DentistFields.tsx         Shared value rendering (missing values, links, phone)
├── PmsDetectionPanel.tsx     Detect PMS / Stop buttons and the progress line
├── PmsFields.tsx             PMS cell: vendor name, matched URL, note
├── EmptyState.tsx
├── ErrorState.tsx
├── LoadingState.tsx
└── ui/                       shadcn/ui components (button, pagination)

lib/
├── config.ts                 The only reader of process.env
├── utils.ts                  cn() for shadcn/ui class merging
├── constants.ts              Every limit, radius, timeout and TTL
├── types.ts                  The normalised domain model
├── validation.ts             Request validation (shared by route and form)
├── errors.ts                 Typed errors with public/internal message split
├── distance.ts               Haversine
├── cache.ts                  TTL cache
├── rate-limit.ts             Fixed-window request budget
├── csv.ts                    RFC 4180 export
├── xlsx.ts                   XLSX export (ZIP + SpreadsheetML, no library)
├── export-columns.ts         The columns every export shares
├── download.ts               Browser download plumbing
├── logger.ts                 Structured server logs
├── api-client.ts             The one place the browser calls the API
├── sheets/
│   ├── auth.ts               Service-account JWT → access token
│   └── client.ts             Tab + header bootstrap, then upsert on Map URL
└── providers/
    ├── types.ts              The DentistSearchProvider interface
    ├── index.ts              Registry: config → implementation
    ├── http.ts               Shared timeout / retry / error mapping
    ├── osm/
    │   ├── index.ts          OsmDentistSearchProvider (+ caching)
    │   ├── nominatim.ts      ZIP → coordinates
    │   ├── overpass.ts       Coordinates → raw OSM elements
    │   └── normalize.ts      Raw elements → Dentist[]
    └── google/
        └── index.ts          Placeholder implementing the same interface

tests/                        Vitest unit tests
```

## Search flow

```
User submits ZIP / count / radius
        │
        ├─ client-side ZIP check (fast feedback only)
        ▼
GET /api/dentists?zip=92618&limit=20&radius=15000&requireWebsite=1
        │
        ├─ request budget check
        ├─ server-side validation (authoritative)
        ▼
getDentistSearchProvider()            ← reads MAP_PROVIDER once, via config
        │
        ├─ provider.geocodeZip("92618")        → { latitude, longitude, displayName }
        └─ provider.searchDentists({ lat, lon, radiusMeters, limit, requireWebsite })
                  │
                  ├─ Overpass query (node + way + relation, out center,
                  │                  website tag filter when requested)
                  ├─ normalise → de-duplicate → sort → slice(limit)
                  ▼
           Dentist[]  (provider-independent)
        │
        ▼
{ success, query, location, count, dentists }
        │
        ▼
Table / cards / empty state / error state, and CSV export
```

### Query parameters

| Parameter | Values | Default |
| --- | --- | --- |
| `zip` | 5-digit US ZIP, or ZIP+4 | required |
| `limit` | `20`, `30`, `50`, `all` | `20` |
| `radius` | `5000`, `10000`, `15000`, `25000`, `50000` (metres) | `15000` |
| `requireWebsite` | `1`/`true`/`yes`/`on`, `0`/`false`/`no`/`off` | `1` |

Anything outside these sets is rejected with a 400 rather than coerced, so a
typo in `requireWebsite` cannot silently widen a search. An **absent** `limit`
means the default, never "no limit" — only the explicit `all` uncaps a request.

### API responses

Success:

```json
{
  "success": true,
  "query": { "zip": "92618", "limit": 20, "radiusMeters": 15000, "requireWebsite": true },
  "location": { "latitude": 33.67, "longitude": -117.75, "displayName": "Irvine, CA 92618" },
  "count": 20,
  "dentists": [ /* Dentist[] */ ]
}
```

Failure — a message that is safe to display, never a stack trace:

```json
{ "success": false, "error": "We couldn't find that ZIP code.", "code": "ZIP_NOT_FOUND" }
```

| Situation | Status | Message |
| --- | --- | --- |
| Malformed or missing ZIP | 400 | Please enter a valid US ZIP code. |
| Disallowed limit or radius | 400 | Choose one of the supported result counts / radii… |
| Unparseable `requireWebsite` | 400 | The website filter must be either on or off. |
| ZIP does not exist | 404 | We couldn't find that ZIP code. |
| Too many requests | 429 | Too many searches. Please wait a moment and try again. |
| Provider failed | 502 | The dentist search service is temporarily unavailable. Please try again. |
| Provider too slow | 504 | The dentist search service took too long to respond. Please try again. |
| Misconfiguration | 500 | The dentist search service is not configured correctly. |

Technical detail — upstream status codes, response snippets, causes — is logged
server-side and never sent to the client.

## Provider abstraction

The contract, in [`lib/providers/types.ts`](lib/providers/types.ts):

```ts
export interface DentistSearchProvider {
  readonly id: ProviderId;
  geocodeZip(zip: string): Promise<GeoLocation>;
  searchDentists(params: SearchDentistsParams): Promise<Dentist[]>;
}
```

The API route contains no provider-specific logic at all:

```ts
const provider = getDentistSearchProvider();
const location = await provider.geocodeZip(query.zip);
const dentists = await provider.searchDentists({ ...location, radiusMeters, limit });
```

Rules the codebase holds to:

- **One switch.** [`lib/providers/index.ts`](lib/providers/index.ts) is the only
  place that maps a provider id to an implementation, and its `switch` is
  exhaustiveness-checked, so adding a provider id without a case is a build error.
- **One env reader.** Only `lib/config.ts` touches `process.env`.
- **No raw provider types above the provider.** Overpass elements and Nominatim
  places exist only inside `lib/providers/osm/`. React never sees them.
- **The provider builds the map URL.** The UI renders `dentist.mapUrl`; it never
  branches on `source` to construct a link.
- **Provider instances are memoised**, because they own their caches.

## The normalised Dentist model

Both providers map their responses onto this shape
([`lib/types.ts`](lib/types.ts)):

```ts
interface Dentist {
  id: string;                 // `${source}:${sourceId}` — globally unique
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  latitude: number;
  longitude: number;
  openingHours: string | null;
  mapUrl: string | null;      // built by the provider
  distanceKm: number | null;  // Haversine, from the ZIP centre
  source: "osm" | "google";
  sourceId: string | null;

  // Optional enrichment: OSM leaves these null, Google can populate them
  // later without a model migration.
  rating?: number | null;
  reviewCount?: number | null;
  businessStatus?: string | null;
  categories?: string[] | null;
}
```

Anything the source does not provide is `null` and renders as `—`. Nothing is
ever fabricated — no invented names, phone numbers, websites, ratings or
reviews. Ratings and review counts are not displayed at all under OSM, because
OSM does not have them.

## OSM provider: Nominatim

Used only for ZIP → coordinates, with a structured postcode query:

```
GET /search?postalcode=92618&countrycodes=us&format=jsonv2&addressdetails=1&limit=1
User-Agent: DentistFinder/1.0 (…)
```

Compliance with the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/):

- an identifying, application-specific `User-Agent` on every request;
- **at most one request per second**, enforced by a promise-chain queue in
  `nominatim.ts`, so concurrent user searches can never produce concurrent
  Nominatim requests;
- results cached for 24 hours (misses for 1 hour), so a repeated ZIP costs
  nothing upstream;
- 10-second timeout;
- no bulk, parallel or automated ZIP enumeration anywhere in the app.

The resolved location is shown in the UI ("Centred on Irvine, CA 92618") so a
surprising geocode is visible rather than hidden.

## OSM provider: Overpass

One POST per uncached search:

```
[out:json][timeout:25];
(
  node["amenity"="dentist"][~"^(website|contact:website|url)$"~"."](around:15000,33.67,-117.75);
  way["amenity"="dentist"][~"^(website|contact:website|url)$"~"."](around:15000,33.67,-117.75);
  relation["amenity"="dentist"][~"^(website|contact:website|url)$"~"."](around:15000,33.67,-117.75);
);
out center;
```

The `[~"keys"~"value"]` clause is the website filter, and it is omitted entirely
when `requireWebsite=0`. Filtering here rather than after the fetch means the
upstream never sends records that are about to be discarded, and `limit` counts
only usable results. The key list is shared with the normaliser
(`WEBSITE_TAG_KEYS` in `lib/constants.ts`) so the set the server filters on and
the set the app reads cannot drift apart. Because a tag can exist and still not
be a link (`website=none` passes a key-existence check), the normaliser re-applies
the filter after parsing — the interface promises that every returned record has
a non-null `website`, and that promise is kept in one place.

- **Nodes, ways and relations** are all queried. `out center` gives ways and
  relations a representative point; elements with no usable coordinates are
  dropped rather than shown at 0,0.
- The in-query `timeout:25` sits below the 30-second client timeout, so Overpass
  can return a proper error before the request is aborted.
- Handled explicitly: HTTP errors, `429`, malformed JSON, an empty result set,
  and Overpass's habit of reporting runtime errors as a `remark` field inside an
  HTTP 200 response.
- Retries, failover and the overall time budget are covered in
  [Upstream reliability](#upstream-reliability).

Addresses are assembled from `addr:housenumber`, `addr:street`, `addr:city`,
`addr:state` and `addr:postcode`, falling back to `addr:full`. Missing parts are
skipped — the UI never shows "undefined" or "null". Websites are accepted only
if they parse as http(s) URLs (a bare `example.com` is upgraded to `https://`),
so a junk tag becomes `—` rather than a broken link.

## Result ordering and de-duplication

**Order: nearest first.** Distance is still the sort key even though the table
no longer shows a Distance column; it remains on the model and in the CSV
export. Distance is the primary key because the search is radius-based — someone searching 5 km expects the closest practices at the top.
A completeness score (name > website > phone > address) only breaks distance
ties, so a well-tagged record wins over a bare one at the same spot, but a
nearby practice is never pushed down the list for lacking a website. Name and id
make the ordering total, so identical inputs always produce identical output.
Records without a name are kept, not filtered out.

**De-duplication is conservative.** Identity is `source + sourceId`. Beyond
that, two records are merged only when they share a name *and* sit within 50 m
of each other — the common case of a POI node mapped inside its own building
way. Unnamed records are never merged, and same-named practices far apart are
kept separate: a false negative (two entries for one business) is much better
than wrongly merging two different dentists.

## Caching

Deliberately small — one in-process TTL map per concern, no Redis, no database:

| Cache | Key | TTL | Why |
| --- | --- | --- | --- |
| Geocoding hit | ZIP | 24 h | ZIP centroids do not move. |
| Geocoding miss | ZIP | 1 h | A non-existent ZIP should not be re-asked, but a newly mapped one should appear the same day. |
| Search | rounded lat/lon + radius + website filter | 10 min | Fresh enough for community-edited data, long enough to absorb repeat searches. |

The search cache key deliberately **excludes `limit`**, so switching between
20/30/50 for the same ZIP and radius re-slices the cached list without touching
Overpass. It does include the website filter, because that changes the query
sent upstream and therefore yields a genuinely different result set. Both caches are bounded by entry count with oldest-first eviction.

Next.js data caching is not used for searches, and the API route sends
`Cache-Control: no-store`: results depend on live upstream data and on the
caller's own parameters, so caching them at the edge would only serve stale
answers.

**Limitation:** the caches live in one process. On a multi-instance or
serverless deployment each instance keeps its own, so the hit rate falls. A
shared store would be needed for a real deployment at scale.

## Rate limiting and responsible use

A fixed-window budget of **20 requests per minute per client** guards the public
endpoints against an accidental loop in a browser tab. Exceeding it returns 429
with a `Retry-After` header. Combined with the allow-listed radii, an uncached
search costs at most one Nominatim request and one Overpass request.

The result count is deliberately *not* part of that protection, because it never
was: every search fetches the full result set for its point and radius, so
`limit=all` and `limit=20` place identical load on Overpass. What bounds the
upstream work is the maximum radius and the request budget. The one real cost of
an uncapped search is a larger JSON response and more rows to render, both borne
by the client that asked for them.

**Limitation:** the counters are in-process and keyed on the forwarded client
address, so behind multiple instances the effective limit is per instance, and
it is a safety net rather than a real quota. A shared store (or the platform's
own rate limiting) would be required for that — deliberately not added here, as
it would mean infrastructure this version does not otherwise need.

The app does no scraping of any kind, and has no bulk-ZIP mode: it is built for
normal interactive search, one ZIP at a time.

## Upstream reliability

The public Overpass endpoint is the least reliable part of this system, and the
app is built to survive that rather than pretend otherwise. Measured, running
the app's own query for ZIP 10001 at 5 km repeatedly: HTTP 200 in ~5 s, then
**504 after 15 s**, then 200 again — roughly one failure in three. Under heavier
use the endpoint stops accepting TCP connections altogether, which surfaces as a
connect timeout rather than as any HTTP status.

What the app does about it:

| Behaviour | Detail |
| --- | --- |
| Retries | Up to 3 attempts (`PROVIDER_MAX_ATTEMPTS`), because a repeat of the identical query usually succeeds. |
| Backoff | Exponential with jitter, capped — simultaneous failures must not retry in lockstep. |
| 429 handling | Retried at most **once**, honouring `Retry-After`. "Over quota" is the server asking us to stop, not a transient wobble. |
| Overall budget | `PROVIDER_TOTAL_BUDGET_MS` (50 s) caps the whole operation, retries and backoff included, so a user never waits minutes for a failure. |
| Endpoint failover | On a connection failure or 5xx, the next configured `OVERPASS_URL` is tried. An unreachable host cannot be fixed by asking it again. |
| Diagnostics | Failures log the full cause chain, not just `fetch failed`. |

That last point matters more than it sounds. `fetch` rejects with a bare
`TypeError: fetch failed` and buries the real reason in `cause`, so a log line
saying only "fetch failed" cannot distinguish an overloaded endpoint from a
broken network. `describeCause` unwraps it:

```
Overpass request failed after 3 attempt(s) against overpass-api.de:
  TypeError: fetch failed
  <- ConnectTimeoutError: Connect Timeout Error
     (attempted addresses: 65.109.112.52:443, 162.55.144.139:443, timeout: 10000ms)
     (UND_ERR_CONNECT_TIMEOUT)
```

which says plainly that the host never accepted a socket — not something a
different query or a longer timeout would fix.

### Adding a fallback endpoint

```env
OVERPASS_URL=https://overpass-api.de/api/interpreter,https://your-mirror/api/interpreter
```

**Verify a mirror's coverage before trusting it.** Public Overpass instances do
not all carry the whole planet. `overpass.osm.ch` answers a New York query in
under a second — with zero results, because it holds only Swiss data. As a
fallback it would turn an outage into a silent, confident "0 dentists found",
which is worse than an error. Query your own area against a candidate first.
Running your own instance avoids the problem entirely.

## Exports

Three destinations, one column definition:

| | Where it runs | Columns |
| --- | --- | --- |
| **Export Excel** (.xlsx) | In the browser | Follow the results |
| **Export CSV** | In the browser | Follow the results |
| **Save to spreadsheet** | On the server | Fixed per tab |

Both file exports carry **only the columns the results can actually fill**, so
an OSM export has no Rating, Reviews, Open Now or Business Status columns, and a
Google export has no Email column — the Places API has no email field, so it
would be empty in every row.

| Result set | Columns |
| --- | --- |
| OSM | Name, Address, Phone, Email, Website, Map URL, Search ZIP |
| Google | Name, Address, Phone, Website, Rating, Reviews, Open Now, Business Status, Map URL, Search ZIP |
| Empty | Name, Address, Phone, Website, Map URL, Search ZIP |

**Search ZIP** is the ZIP typed into the form, not the practice's own — a 92618
search legitimately returns Lake Forest 92630, so a column called simply "ZIP"
sitting next to those addresses would read as a claim about the practice. It sits
last, because it repeats the same value down a single export - useful for telling
searches apart in a sheet that collects many, but not what anyone reads first. It is a query value rather than a property of
any result, so it travels to the writers as an `ExportContext` instead of being
written onto the `Dentist` model.

Like the table, this is decided by `selectExportColumns(dentists)` — a check on
the data, never on `dentist.source`. A mixed set keeps every column any row can
fill, and a future provider needs no change. Header and cells come from a single
column definition in `lib/export-columns.ts`, so a header cannot drift out of
step with the values beneath it.

The **Google Sheets** destination deliberately uses a *different* rule —
`sheetColumnsFor(provider)`, a fixed set per tab. A sheet is appended to over
time and its header is written once; if its columns followed each search's data,
the first search that returned no email would shift every later row a column
left. See [Saving to Google Sheets](#saving-to-google-sheets).

### The .xlsx writer

`lib/xlsx.ts` writes a real workbook — a ZIP of SpreadsheetML parts — with **no
library**. An .xlsx is a handful of small XML files in a ZIP, and the subset
needed for one sheet of text and numbers is short enough to read in full. That
keeps the runtime dependency count at zero and keeps a spreadsheet parser, an
historically rich source of CVEs, out of a bundle that ships to every visitor.
Entries are stored uncompressed: deflate exists for size, and these files are a
few kilobytes.

What it gives you over the CSV:

- **Ratings and review counts as numbers**, so they sort and average. A CSV
  import makes them text unless you intervene.
- **Phone numbers and ZIPs stay text**, so `+1 949-555-1234` is not read as a
  formula and `02134` does not become `2134`. Ratings are numbers because
  arithmetic on them means something; a ZIP is an identifier that merely looks
  like one.
- A **frozen, bold header row** and sensible column widths.
- No import dialog, and no encoding guesswork.

It deliberately does *not* do formulas, multiple sheets, merged cells, dates or
a shared-string table. Anything beyond one flat sheet belongs in a library.

## Verifying the Excel export

The unit tests parse the archive back with a reader written independently of the
writer, so a mistake in the ZIP layout cannot agree with itself and pass. That
still only proves the two halves agree, so the workbook is also opened with a
real ZIP implementation. Generated from a live OSM search for ZIP 92618:

```
is_zipfile: True
CRC check: all entries OK
parts:
  [Content_Types].xml                 680 bytes
  _rels/.rels                         296 bytes
  xl/workbook.xml                     286 bytes
  xl/_rels/workbook.xml.rels          424 bytes
  xl/styles.xml                       689 bytes
  xl/worksheets/sheet1.xml          10939 bytes
all parts parse as XML: yes
header row: ['Name', 'Address', 'Phone', 'Email', 'Website', 'Map URL']
rows incl. header: 21
```

And for a Google-shaped record, cell by cell — note E and F are numbers:

```
headers: ['Name','Address','Phone','Website','Rating','Reviews','Open Now','Business Status','Map URL']
  A2   text    Irvine Dental Group
  B2   text    123 Main St, Irvine, CA 92618
  C2   text    +1 949-555-1234
  D2   text    https://www.irvinedentalgroup.com
  E2   number  4.8
  F2   number  247
  G2   text    Yes
  H2   text    OPERATIONAL
  I2   text    https://www.google.com/maps/place/?q=place_id:ChIJ1
frozen header: True
```

## Saving to Google Sheets

Optional. Unset, the app is fully usable and the button is not rendered.

**Two tabs, `osm` and `google`**, each with the columns its provider can fill.
Both the tab and its header row are created on first use, so a fresh spreadsheet
needs no manual setup. A save is an **upsert keyed on the Map URL column**, which
is unique per practice: a practice the tab has never seen is appended, one it
already has is rewritten only where a value changed, and the rest are left
alone. The app reports the three counts after every save, so clicking twice
adds nothing twice. Two rules keep old data safe: a blank in the new results
never erases a value the sheet holds (a PMS found last month survives a save
made before this month’s scan ran), and the Search ZIP keeps the value from
the first save. Nothing is ever deleted.

### Setup

1. **Create a service account.** Writing to someone's spreadsheet needs an
   identity, which an API key cannot provide. Google Cloud Console → IAM & Admin
   → Service Accounts → Create, then Keys → Add key → Create new key → JSON.
2. **Enable the Google Sheets API** for that project.
3. **Share the spreadsheet** with the service account's address as an **Editor**.
   Skipping this is the most common failure, and returns 403.
4. Set `SHEETS_SPREADSHEET_ID`, `SHEETS_CLIENT_EMAIL` and `SHEETS_PRIVATE_KEY`
   (see `.env.example`). All three or none: a half-configured set is refused at
   startup rather than at the first click.

### Two kinds of document, two ways to write

A `/spreadsheets/d/...` link can point at either of two things, and they are not
written the same way. The app checks which it has and picks the path:

| Document | How rows are added |
| --- | --- |
| **Native Google Sheet** | Sheets API: read the tab, `values.batchUpdate` the rows that changed, `values.append` the new ones |
| **Uploaded .xlsx** | Drive API: fetch the workbook, insert the rows, write it back to the same file id. Append only, so a second save of the same search adds its rows again |

The second exists because the Sheets API refuses Office files outright:

```
400 FAILED_PRECONDITION
This operation is not supported for this document.
The document must not be an Office file.
```

The Drive path keeps the file's id, so **the link, the sharing and the revision
history all survive** — and because Drive versions every write, a bad save is
recoverable through File > Version history.

That rewrite is deliberately surgical. Every ZIP entry is copied over untouched
except the one worksheet being appended to, and inside that worksheet only new
`<row>` elements are inserted before `</sheetData>`. Formatting, formulas,
shared strings and the other tabs are never parsed, so they cannot be damaged;
`tests/xlsx-edit.test.ts` asserts byte-for-byte equality on every other part.

New rows use inline strings rather than the shared-string table, so
`sharedStrings.xml` never has to be rewritten — one less part that can be
corrupted, and the two representations coexist happily in one sheet.

The one thing the .xlsx path cannot do is create a missing tab: adding a
worksheet means editing `workbook.xml`, its relationships and the content types
together. If the tab is absent the save says so and names the tabs the workbook
does have. A native Google Sheet has no such limit — the tab is created for you.

### Checking the setup

`GET /api/dentists/save` (development only) walks the four things that have to
line up and names the first that fails, with the fix. Visit it in a browser
after changing anything:

```
overall ok: False
  PASS  Environment variables
  PASS  Service-account credentials    Google issued an access token.
  FAIL  Open the spreadsheet           The caller does not have permission
        FIX: Share the spreadsheet with <service account> as an Editor.
```

Without it, any one of those four produces the same opaque HTTP error. It is
404 in production, because it reports on configuration.

### Why the endpoint takes a query, not rows

`POST /api/dentists/save` receives the **search parameters** and re-runs the
search server-side, appending what the provider returned. Had it accepted rows
from the browser, anyone could write anything into the spreadsheet. The search
is cached, so re-running it costs nothing and, under Google, is not billed
twice. The endpoint shares the app's rate limiter.

Credentials never reach the browser. The page is told only *whether* the
integration is configured, computed on the server by `isSheetsConfigured()`, so
it knows whether to render the button.

## PMS detection

Optional, needs no credentials, and described in
[docs/pms-detection.md](docs/pms-detection.md).

Click **Detect PMS** on a set of results and the server looks at each
practice's public website for URLs that belong to a known practice management
or patient-engagement vendor: where "Book Appointment", "Patient Portal",
"Forms" and "Contact" lead, what is embedded, and where those redirect to.

```
results table ──► POST /api/pms/detect ──► job id
                                            │
      GET /api/pms/jobs/<id> ◄── browser polls ──► PMS column fills in
      PATCH /api/pms/jobs/<id> ◄── Stop / Resume ──► scan holds its place, or goes on
                                            │
              homepage ──► appointment / portal / forms / contact pages
              ──► follow redirects ──► match every URL's host against
                  lib/pms/identifiers.ts ──► "Denticon" or blank
```

The result is a name or nothing: `Denticon`, `Weave, Denticon` when a site
points at more than one vendor, or an empty cell. A blank means only that no
known vendor URL was found on the site; most desktop systems leave none. The
table also shows the URL that named the vendor, or why nothing was found; the
spreadsheet and the file exports carry the name alone, in one column, `PMS`,
appended after the existing columns.

The crawler fetches at most eight pages and twelve requests per site, three
sites at a time, HTML only, honours robots.txt, never submits a form or logs
in, and checks every URL and redirect hop against private address ranges before
requesting it.

## Switching from OSM to Google

The intended future flow, with no other code changes:

```env
MAP_PROVIDER=google
GOOGLE_MAPS_API_KEY=your-server-side-key
```

**The Google provider is implemented.** It lives entirely in
`lib/providers/google/`, mirroring the OSM folder:

```
lib/providers/google/
├── index.ts        GoogleDentistSearchProvider (+ caching)
├── geocoding.ts    ZIP → coordinates (Geocoding API)
├── places.ts       Places API (New) Text Search, with pagination
└── normalize.ts    Place → Dentist
```

**Nothing outside that folder changed to add it**, with one deliberate
exception. The React components, `/api/dentists`, `lib/validation.ts`, the
`Dentist` model, the CSV export, the search flow, the URL scheme and the error
handling are identical for both providers.

The one thing that cannot be provider-agnostic is **attribution**: the ODbL
requires crediting OpenStreetMap, Google's policy requires "Powered by Google",
and a page doing the first while showing the second's data is simply false. The
app currently shows neither — see [Attribution](#attribution).

### Prerequisites

The Google Cloud project needs, in this order:

1. **Billing enabled.** Maps Platform refuses every request without it, even
   inside the free monthly credit, with
   `REQUEST_DENIED: You must enable Billing on the Google Cloud Project`.
2. **Geocoding API** and **Places API (New)** enabled for the project.
3. A key with no HTTP-referrer restriction, or an IP restriction that allows
   your server. The key is used server-side only and is never sent to a browser.

Both failure modes surface as a `CONFIGURATION_ERROR` whose server log carries
Google's own explanation verbatim, so you are told which of the three it is.

### Differences from the OSM provider

These are properties of the Places API, not of this app, and each is enforced
honestly rather than papered over:

| | OSM | Google |
| --- | --- | --- |
| Email | Present for roughly a third of records | **Never** — Places has no email field, so the CSV omits the column entirely |
| Rating / reviews | Not available (`null`); no such CSV columns | Populated (`rating`, `reviews`); the table shows them and the CSV exports them |
| Open now (`currentOpen`) | Not available (`null`) — see below | Populated from `currentOpeningHours.openNow` |
| Business status | Not available (`null`) | e.g. `OPERATIONAL`, `CLOSED_TEMPORARILY` |
| Phone format | Whatever the `phone` tag holds | International first: `+1 949-555-1234` |
| Map URL | `openstreetmap.org/node/123` | `google.com/maps/place/?q=place_id:…` |
| `shortAddress` | Same as `address` — `addr:*` tags carry no country | `address` minus the trailing `, USA` |
| "All (no limit)" | Everything in the radius | **At most 60** — Places returns 20 per page for 3 pages |
| Website filter | Pushed into the Overpass query | Applied after mapping; Places has no such parameter |
| Radius | Enforced by Overpass | `locationBias` is a bias, not a restriction, so the exact radius is enforced in `normalize.ts` |

**Why `currentOpen` is null under OSM.** OSM stores `opening_hours` as a grammar
(`Mo-Fr 09:00-17:00; PH off`), not a flag. Turning that into a boolean correctly
needs a full parser plus the practice's own timezone; doing it approximately
would mean telling someone a closed surgery is open. So OSM reports "unknown",
and the CSV cell is empty rather than `No`.

**`currentOpen` is a snapshot, not a live flag.** Google evaluates it when it
answers, and search results are cached for `SEARCH_CACHE_TTL_MS` (10 minutes),
so a practice that closes during that window still reads as open until the entry
expires. It is accurate to within the cache TTL, and the CSV records the state
at fetch time, not at the time the file is opened.

### Cost

Every uncached search is billed: one Geocoding call plus one Places Text Search
call per page. The provider limits what it fetches to what the request could
need — a 20-result search with no website filter costs a single page, not three
— and both the geocode and the search are cached, so repeating a search or
changing the result count costs nothing. The field mask is kept to exactly the
fields the model uses, since the mask determines the billing SKU.

### Still worth reviewing before production

The app currently shows no attribution at all (see
[Attribution](#attribution)), and Google's terms carry their own attribution
and caching requirements — notably limits on how long Places data may be
stored, which should be checked against the TTLs in [Caching](#caching).
Nothing in the architecture prevents this; it is simply not something a
provider swap can decide for you.

## Attribution

The app currently renders **no provider credit**: the footer that carried it
(`components/SiteFooter.tsx`) and the per-provider text behind it
(`lib/providers/attribution.ts`) have been removed. Both data sources make a
credit a condition of use, not decoration — the ODbL requires "Map data ©
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright)", and
Google's policy requires "Powered by Google" wherever Places data is shown
outside a Google map. Add one back before this is shown to anyone outside your
team; `git log -- components/SiteFooter.tsx` has the previous implementation.

## Known limitations

1. **OpenStreetMap is community-maintained and incomplete.** It is not a
   register of dentists. Some practices are missing entirely; websites, phone
   numbers and addresses are often absent; some entries are out of date. The UI
   says so beneath the results.
2. **Fewer results than requested is normal**, especially at small radii.
3. **ZIP geocoding is only as good as OSM's postcode data.** Verified example:
   `postalcode=60601` resolves, in Nominatim itself, to Riverside IL rather than
   downtown Chicago, because that is where the matching OSM object sits. The app
   reports what the geocoder returned and shows the resolved location so the
   discrepancy is visible. A ZIP-centroid dataset (see *Future scale*) would fix
   this class of problem.
4. **Public endpoints are shared and rate-limited.** Overpass fails roughly one
   request in three under load (504s, and refused connections once an IP has
   been busy). The app retries, fails over to any configured mirror, and then
   reports a friendly error. Expect failures during rapid testing; they clear on
   their own. See [Upstream reliability](#upstream-reliability).
5. **Caches and rate-limit counters are per process** (see the sections above).
6. **ZIP+4 is accepted but truncated** to the 5-digit code, which is what OSM
   maps.
7. **Distances are straight-line**, not driving distance.
8. **Email coverage is partial.** About a third of website-having dentists also
   carry an `email`/`contact:email` tag, so the Email column is frequently `—`.
   Nothing is inferred: an address is never constructed from a website domain,
   and no `info@`-style guess is ever made.
9. **The website filter reflects OSM's tagging, not reality.** A practice with a
   perfectly good website that nobody has added to OSM is excluded while the
   filter is on. It narrows results substantially — on ZIP 92618 at 5 km, from 8
   to 2 — so clear the checkbox when you want everything OSM knows about.
10. **An uncapped search can return a lot of rows.** "All (no limit)" renders
    every match in one plain table, with no pagination or virtualisation. That
    is fine for the hundreds a 50 km radius yields, but it is the one place
    where a very dense area will feel heavy in the browser.
11. **"No PMS" means the website was checked and no known vendor URL appeared**
    on it. Most desktop systems leave none, so it is not proof that the practice
    runs nothing. A blank PMS cell means the site could not be checked at all
    (no website, unreachable, blocked by robots.txt) or has not been scanned.
    See [docs/pms-detection.md](docs/pms-detection.md).
12. **PMS scan jobs live in one process for an hour**, like the search cache
    above, so a restart forgets them and a multi-instance deployment keeps its
    own per instance. "Save to spreadsheet" fills the PMS column from that
    job, so save within the hour, on the same server.

## Testing

```bash
npm test          # 184 unit tests
npm run lint
npm run build
```

The unit tests ([`tests/`](tests/)) cover the logic worth protecting:

- **ZIP validation** — valid (`92618`, `10001`, `90210`, ZIP+4), invalid
  (`abc`, `123`, `123456`, empty), whitespace, and the public/internal message split.
- **Result limits** — 20/30/50 accepted; 0, -1, 10, 21, 100 and non-numeric
  rejected; `all` (any casing) means no cap; a *missing* parameter falls back to
  the default rather than uncapping; 99999 is still refused.
- **Upstream resilience** (with `fetch` stubbed) — recovery from a 504, from a
  dropped connection, and from two consecutive failures; giving up at the
  attempt limit; not retrying a 4xx; obeying a 429; the wall-clock budget
  stopping further attempts; failover to a second endpoint on both connection
  failure and 5xx; staying on a healthy primary; and `describeCause` unwrapping
  a nested cause chain without looping on a circular one.
- **Provider capping and caching** (with Overpass stubbed) — the cap is applied,
  an uncapped search returns all 137 of 137 results, short result sets are not
  padded, nearest-first order survives an uncapped search, Overpass is asked
  exactly once per point/radius regardless of limit, and a filtered search is
  never served from an unfiltered cache entry.
- **Radius** — the five offered values including minimum and maximum; below-min,
  above-max and in-range-but-not-offered all rejected.
- **Website filter** — the default is on; `1/true/yes/on` and `0/false/no/off`
  both directions; ambiguous values rejected; the Overpass query carries the tag
  filter on every element type when on and no filter at all when off; the query
  keys stay in step with the normaliser; filtered results all have a website;
  and `website=none` is dropped even though the upstream key check passed it.
- **Normalisation** — a complete OSM record; missing website, phone, address and
  name; an element with no tags; a way with `center`; a relation with `center`;
  an element with no coordinates; alternative `contact:*` tags; address
  assembly and `addr:full` fallback; website sanitising.
- **De-duplication** — repeated identity, node-inside-its-own-way, same name far
  apart (kept), unnamed at the same spot (kept).
- **Sorting** — nearest-first, completeness as tie-break only, determinism.
- **CSV** — commas, quotes, newlines, missing fields, empty result set, and the
  email column; column selection (an OSM export carrying no Google columns, a
  Google export carrying no Email column, a mixed set keeping both, a rating of
  `0` counting as data, and the choice never consulting `dentist.source`);
  header/row alignment across every column set the selector can produce; the
  Google-shaped row; the country-trimmed address; and `Open Now` dropping out
  entirely rather than reading `No` when no row knows its state.
- **The .xlsx writer** — base-26 column letters, XML escaping (including
  dropping control characters XML cannot represent), the CRC-32 check value,
  a ZIP that reads back entry for entry through an independently written
  reader, a central-directory offset that points at a real record,
  deterministic bytes, numeric rating cells, a frozen header, omitted empty
  cells, and the same column set the CSV uses.
- **Google Sheets** — the fixed per-tab column sets and their independence from
  the data, row shaping (numbers stay numbers, absent values become empty
  cells), a signed JWT with the right claims, token reuse across calls, the
  private key never appearing in an error, tab creation, header bootstrap, not
  rewriting an existing header, appending rather than overwriting, `RAW` input,
  routing OSM rows to the `osm` tab and Google rows to `google`, and the three
  failure modes an operator actually hits: 403 (not shared), 404, and an
  uploaded .xlsx the API cannot write to.
- **Sheets configuration** — off by default, all three variables required
  together, escaped newlines restored in the PEM key, and a non-PEM value
  rejected.
- **Editing an .xlsx in place** — a ZIP round trip through deflate, reading an
  archive a different compressor produced, resolving a tab through its
  relationship rather than by file order (the fixture puts `osm` in
  `sheet2.xml` on purpose), continuing row numbering rather than restarting,
  a self-closing empty `sheetData`, numbers staying numbers, XML escaping,
  extending a stale `dimension`, **every other part surviving byte for byte**,
  the other provider's tab going untouched, a header written only into an empty
  tab, a second append continuing the log, and a missing tab naming the ones
  that exist.
- **The Search ZIP column** — it closes every export, carries the searched ZIP
  rather than the practice's, survives an empty result set, keeps a leading
  zero as text in all three destinations, and appears in the header a sheet tab
  is created with.
- **Ratings columns** — `hasRatings` is false for an OSM result set, true as
  soon as one result has a rating or a review count, false for an empty set, and
  never looks at `dentist.source`.
- **Provider selection** — `MAP_PROVIDER=osm` returns the OSM provider,
  `google` returns the Google provider, unknown values and a missing Google key
  produce clear configuration errors, instances are memoised.
- **The Google provider** (with `fetch` stubbed, so the suite never calls Google
  and never bills anyone) — ZIP geocoding and its exact component filter, an
  unknown ZIP, `REQUEST_DENIED` and the HTTP-400 invalid-key response both
  becoming configuration errors, the full documented result shape in one
  assertion, `email` staying null, the country-trimmed `shortAddress` alongside
  the verbatim `address`, the international phone preference, the place-id map
  URL, `currentOpeningHours` winning over the regular schedule and an unstated
  open state staying null, places outside the radius being
  dropped, nearest-first ordering, the website filter, pagination across pages,
  the 60-result ceiling, the key travelling in a header and never in the URL,
  and caching plus bounded paging so a small search is not over-billed.

Manual verification against the live endpoints is described in the summary of
the work; note that hammering the public Overpass endpoint will produce 429s.

## Future scale

Documented as direction, not implemented:

```
Version 1   Next.js → Nominatim → Overpass                (this repo)
Version 2   Next.js → cached ZIP-centroid dataset → Overpass
Version 3   Next.js → own OSM extract in PostGIS
Version 4   Next.js → Google Places provider
```

Version 2 is the highest-value next step: a static US ZIP-centroid dataset
removes the Nominatim dependency from the hot path entirely, along with its
one-request-per-second ceiling and the geocoding accuracy problem in *Known
limitations*. Each step is a change behind the same `DentistSearchProvider`
interface.
