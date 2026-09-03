# PMS detection

Names the practice management system (PMS) or patient-engagement vendor a
dental practice's public website points at, by looking at URLs alone.

```
website
  → fetch the homepage
  → find relevant links (Book Appointment, Schedule, Patient Portal, Forms,
    New Patient, Contact, Login, Pay ...), plus every form action, iframe,
    script and data-url on the page
  → follow the relevant internal pages, then the external destinations those
    journeys lead to, recording every HTTP redirect hop
  → match the host of every URL seen against lib/pms/identifiers.ts
  → "Denticon" | "Weave, Denticon" | null
```

Examples:

- `https://example.com/forms` → `https://patientregistration.denticon.com/...` → **Denticon**
- `https://example.com/book` → `https://book.getweave.com/...` → **Weave**
- `https://example.com/portal` → `https://www.patientviewer.com/?RSID=...` → **Open Dental**
- nothing recognised → **null**

This is URL matching, not an inference about what software the practice runs
internally. Null means only that no known vendor URL appeared on the site.

## Where the result goes

| Destination | What it gets |
| --- | --- |
| Results table and cards | The name, plus the URL that named each vendor, or a short note on why nothing was found (site could not be fetched, robots.txt, JavaScript-only site, no vendor URL). |
| Google Sheet | One column, **PMS**, appended after the existing columns. The name or an empty cell. Nothing else. |
| CSV / Excel export | One column, **PMS**. The name or an empty cell. |

`Dentist.pms` is `string | null`. The table-only details (`matches`, `note`)
live in the scan job's response and never reach a sheet or a file.

## How it runs

`POST /api/pms/detect?<search query>` starts a job for the dentists that search
returns and answers with a job id; the browser polls `GET /api/pms/jobs/<id>`
every two seconds and fills the table as results arrive. A failed poll is
retried rather than treated as the end, and a job the server has forgotten
(it restarted) is started again once. Clicking the button again while a job is
running or stopped returns the same job; clicking it after the job has
finished scans again. "Stop" sends `PATCH /api/pms/jobs/<id>` with
`{"action":"pause"}`: the sites being scanned at that moment finish, no
further one starts, and the job keeps its place. "Resume" sends
`{"action":"resume"}` and the scan continues from the next unscanned website.
While stopped, the names found so far are in the table and are what the
exports and "Save to spreadsheet" use; a job left stopped for an hour is
forgotten. While a scan runs, the search form, "Save to spreadsheet" and both
exports are disabled, and while a search runs "Detect PMS" is, so the two
never overlap. There is no result cache. Jobs live in the server
process for an hour, which is what lets "Save to spreadsheet" fill the PMS cell:
the server re-runs the search and attaches the names from its own scan of that
search, so the browser never supplies them. A save more than an hour after the
scan, or after a server restart, writes empty PMS cells.

Crawl limits are constants in [`lib/pms/constants.ts`](../lib/pms/constants.ts):
8 pages and 12 requests per site, 10 s per request, 5 redirects, 5 external
destinations, 60 s per site (cut off at 90 s regardless), 3 sites at a time. A
site that fails or overruns is recorded as null with a note and the job moves
on; nothing about one website stops the others. There is no browser rendering;
a site whose links exist only after JavaScript runs reports null with a note
saying so.

The crawler honours robots.txt, fetches HTML only, never submits a form or logs
in, and checks every URL and redirect hop against loopback, private, link-local
and cloud-metadata address ranges before requesting it
([`lib/pms/crawler/ssrf.ts`](../lib/pms/crawler/ssrf.ts)).

## Identifiers

[`lib/pms/identifiers.ts`](../lib/pms/identifiers.ts) is a flat list of
`{ name, domains }`. A URL names a vendor when its host is one of the domains
or a subdomain of one. A link to the vendor's own marketing site counts.

Named: RevenueWell, Weave, NexHealth, Adit, Dental Intelligence, Modento,
Yapi, Solutionreach, Mango Voice, Flex Dental, Lighthouse 360, Dentrix,
Dentrix Ascend, Eaglesoft, Open Dental, Curve Dental, Denticon, CareStack,
DentiMax, Sensei, Dentally, tab32, Practice-Web, SoftDent, ClearDent, axiUm,
WinOMS, MacPractice, iDentalSoft, Cloud 9, Planet DDS, Carestream Dental.

Only competitors are listed. Marketplaces and embeddable widgets that merely
present a practice (Zocdoc, LocalMed, Demandforce and the like)
are deliberately absent, so a URL pointing at them is ignored.

Two entries have no domain of their own and are never matched directly:
**SoftDent** and **WinOMS** are sold under `carestreamdental.com`, so a site
pointing there is named "Carestream Dental". Likewise `mytooth.io` serves both
Denticon and Cloud 9 practices and is named "Planet DDS". A family name is
dropped when one of its products was also found, so a site is "Denticon", never
"Denticon, Planet DDS".

Still unverified, and therefore absent: RevenueWell's online-scheduling link
host (its help centre blocks automated reads; `app.revenuewell.com` does not
resolve), and the hostname of Weave's Text Connect widget script.

To add a vendor, add one line to `PMS_IDENTIFIERS`. Nothing else changes.

## Known limitations

- Null is not "no PMS". Most desktop systems leave no public trace.
- A vendor's marketing link counts, so a blog post linking to `dentrix.com`
  names Dentrix. That is by design; the table shows the matching URL so it can
  be judged.
- Links rendered only by JavaScript are not seen.
- Jobs are per server process and kept for an hour; a restart forgets them,
  and the sheet gets a PMS name only when the scan ran on the same server
  within that hour.
