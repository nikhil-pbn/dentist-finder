/**
 * PMS detection settings: the crawl limits and the relevance table the crawler
 * uses to decide which pages are worth a request. Configuration-by-code, so a
 * change is a reviewed diff.
 */

/** Identifies the crawler to site owners. */
export const PMS_USER_AGENT =
  "DentistFinderPMSBot/1.0 (+https://github.com/nikhil-pbn/dentist-finder)";

/** The product token robots.txt groups are matched against. */
export const PMS_ROBOTS_TOKEN = "DentistFinderPMSBot";

/* -------------------------------------------------------------------------- */
/* Crawl limits                                                               */
/* -------------------------------------------------------------------------- */

/** Websites scanned at the same time within one job. */
export const PMS_MAX_CONCURRENT_SITES = 3;

/**
 * Per-website ceilings. Deliberately small towards the sites being scanned: a
 * handful of pages, with every redirect hop counted as a request.
 */
export const PMS_CRAWL_LIMITS = {
  /** HTML pages fetched per website, homepage included. */
  maxPagesPerSite: 8,
  /** Every HTTP request, redirect hops and robots.txt included. */
  maxRequestsPerSite: 12,
  requestTimeoutMs: 10_000,
  maxRedirects: 5,
  /** Bodies larger than this are truncated; a dental homepage is far smaller. */
  maxHtmlBytes: 1_500_000,
  /** External booking/portal destinations followed per website. */
  maxExternalProbes: 5,
  /** Wall-clock ceiling for one website. */
  siteTimeBudgetMs: 60_000,
};

/** robots.txt lookups for hosts other than the site itself, per website. */
export const PMS_MAX_EXTERNAL_ROBOTS_LOOKUPS = 4;

/** Inline-script URL literals kept per page, so a bundle cannot flood us. */
export const PMS_MAX_INLINE_SCRIPT_URLS = 200;

/* -------------------------------------------------------------------------- */
/* Page relevance                                                             */
/* -------------------------------------------------------------------------- */

export interface RelevanceRule {
  pattern: RegExp;
  score: number;
}

/**
 * Scores a link by what it is about, judged from its text, its accessible
 * name and its path. Highest matching rule wins. A page that matches nothing
 * scores zero and is never crawled: the detector looks at patient journeys,
 * not at the whole site.
 */
export const PMS_RELEVANCE_RULES: readonly RelevanceRule[] = [
  // "Book an appointment", "Schedule your visit", "Request a consultation".
  {
    pattern:
      /\b(book|schedule|request|make|reserve)\b[\s-]*(an?[\s-]*|your[\s-]*|my[\s-]*)?(appointment|appt|visit|online|now|consult|consultation|checkup|check-up|cleaning)/i,
    score: 100,
  },
  // Appointments.
  { pattern: /\bappointments?\b|\bappt\b/i, score: 95 },
  // Booking and scheduling.
  { pattern: /\b(book|booking|schedule|scheduling|scheduler)\b/i, score: 90 },
  // Patient portal and patient login.
  { pattern: /patient[\s-]*(portal|login|log[\s-]*in|sign[\s-]*in|access|account)/i, score: 90 },
  { pattern: /\bportal\b/i, score: 85 },
  // New patients.
  { pattern: /new[\s-]*patients?/i, score: 70 },
  // "Online Tools", "Online Forms", "Patient Resources": the page a practice
  // parks its portal and registration links on, under any of many names.
  {
    pattern:
      /\bonline\s*(tools|services|resources|forms?|registration|register|check[\s-]?in|payments?)\b|patient\s*(resources|information|info|centre|center|tools|services)/i,
    score: 65,
  },
  // Forms and registration.
  { pattern: /\b(forms?|paperwork|registration|intake)\b/i, score: 55 },
  { pattern: /\bcheck[\s-]?in\b/i, score: 50 },
  // Contact.
  { pattern: /\bcontact(\s*us)?\b/i, score: 50 },
  { pattern: /\bconsult(ation)?s?\b/i, score: 45 },
  // Login.
  { pattern: /\b(log[\s-]*in|sign[\s-]*in|my[\s-]*account)\b/i, score: 40 },
  // Payments.
  { pattern: /\b(pay(ment)?s?[\s-]*(online|my[\s-]*bill|bill)|bill[\s-]*pay)\b/i, score: 35 },
];

/** Internal pages below this relevance are not worth a request. */
export const PMS_MIN_CRAWL_RELEVANCE = 30;

/** External destinations below this are not followed. */
export const PMS_MIN_PROBE_RELEVANCE = 40;

/** Small bonus for links in the site's navigation or footer, where journeys start. */
export const PMS_NAVIGATION_BONUS = 5;

/**
 * Resources that are never HTML and never worth downloading. Matched against
 * the path's extension.
 */
export const PMS_SKIPPED_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z",
  "jpg", "jpeg", "png", "gif", "svg", "webp", "avif", "bmp", "ico", "tif", "tiff",
  "mp3", "mp4", "m4a", "m4v", "mov", "avi", "wmv", "webm", "ogg", "wav", "flac",
  "css", "js", "mjs", "json", "xml", "txt", "csv", "rss", "atom",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dmg", "apk", "msi",
]);

/**
 * External hosts that appear on almost every practice site and can never be
 * PMS infrastructure. Not probed, so the request budget goes to real journeys.
 */
export const PMS_IGNORED_EXTERNAL_HOSTS = [
  "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "youtube.com", "youtu.be", "tiktok.com", "pinterest.com", "yelp.com", "google.com",
  "goo.gl", "maps.app.goo.gl", "apple.com", "play.google.com", "wikipedia.org",
  "healthgrades.com", "vimeo.com", "bit.ly", "t.co", "threads.net",
  "nextdoor.com", "bbb.org", "ada.org", "mouthhealthy.org", "wa.me", "m.me",
];

/** Content types the crawler is willing to parse as pages. */
export const PMS_HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Finished jobs are kept this long, then dropped. Long enough for a late poll,
 * and for "Save to spreadsheet" to pick up the names the scan found.
 */
export const PMS_JOB_TTL_MS = 60 * 60 * 1_000;
export const PMS_MAX_JOBS = 50;
