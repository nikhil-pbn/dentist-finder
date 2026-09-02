/**
 * Google Sheets destination tests.
 *
 * `fetch` is stubbed throughout: the suite must never touch a real spreadsheet,
 * both because tests should not depend on the network and because this code
 * writes.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSheetsConfigured, loadConfig, type SheetsConfig } from "@/lib/config";
import { ConfigurationError } from "@/lib/errors";
import { sheetColumnsFor } from "@/lib/export-columns";
import { buildAssertion, getAccessToken, resetAccessTokenCache } from "@/lib/sheets/auth";
import {
  appendRows,
  ensureSheetReady,
  toSheetRows,
  type SheetTarget,
} from "@/lib/sheets/client";
import type { ProviderId } from "@/lib/constants";
import type { ExportContext } from "@/lib/export-columns";
import type { Dentist } from "@/lib/types";
import { XLSX_MIME } from "@/lib/constants";
import { diagnoseSheets } from "@/lib/sheets/diagnose";
import { readZip, writeZip } from "@/lib/sheets/xlsx-edit";
import { makeDentist } from "./factories";

/** The ZIP that was searched, recorded as its own column in the sheet. */
const CONTEXT = { zip: "92618" };

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CONFIG: SheetsConfig = {
  spreadsheetId: "1jT4QLtest",
  clientEmail: "dentist-finder@example.iam.gserviceaccount.com",
  privateKey,
};

const fetchMock = vi.fn();

/** What the save route does: prepare the tab, then append to it. */
async function appendDentistsToSheet(
  config: SheetsConfig,
  provider: ProviderId,
  dentists: readonly Dentist[],
  context: ExportContext,
): Promise<Pick<SheetTarget, "tab" | "createdTab" | "wroteHeader" | "mode"> & { appendedRows: number }> {
  const target = await ensureSheetReady(config, provider);
  const appendedRows = await appendRows(config, target, dentists, context);
  return {
    tab: target.tab,
    appendedRows,
    createdTab: target.createdTab,
    wroteHeader: target.wroteHeader,
    mode: target.mode,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

/** Answers each Sheets endpoint, with per-test overrides for the two reads. */
function stubSheets(
  overrides: {
    tabs?: string[];
    headerRow?: string[] | null;
    mimeType?: string;
    canEdit?: boolean;
    workbook?: Buffer;
  } = {},
) {
  const tabs = overrides.tabs ?? ["osm", "google"];
  const headerRow = overrides.headerRow === undefined ? ["Name"] : overrides.headerRow;
  const mimeType = overrides.mimeType ?? "application/vnd.google-apps.spreadsheet";
  const canEdit = overrides.canEdit ?? true;

  fetchMock.mockImplementation(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      // Binary bodies matter too: the .xlsx path PATCHes a whole workbook.
      body:
        typeof init.body === "string" ? safeParse(init.body) : (init.body ?? null),
    });

    if (url.includes("oauth2.googleapis.com/token")) {
      return json({ access_token: "test-token", expires_in: 3600 });
    }
    if (url.includes("/upload/drive/v3/files/")) {
      return json({ id: "1jT4QLtest" });
    }
    if (url.includes("/drive/v3/files/")) {
      if (url.includes("alt=media")) {
        return new Response((overrides.workbook ?? Buffer.alloc(0)) as BodyInit);
      }
      return json({
        id: "1jT4QLtest",
        name: "Dentist Finder",
        mimeType,
        capabilities: { canEdit },
      });
    }
    if (url.includes("fields=sheets.properties.title")) {
      return json({ sheets: tabs.map((title) => ({ properties: { title } })) });
    }
    if (url.includes("/values/") && (init.method ?? "GET") === "GET") {
      return json(headerRow ? { values: [headerRow] } : {});
    }
    return json({});
  });
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function callTo(fragment: string, method?: string): Call | undefined {
  return calls.find(
    (call) => call.url.includes(fragment) && (!method || call.method === method),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  calls = [];
  resetAccessTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Drive-hosted .xlsx with a single `osm` tab, as Excel would produce it. */
function officeWorkbook(): Buffer {
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types/>',
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook><sheets><sheet name="osm" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<?xml version="1.0"?><sst count="0"/>',
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row></sheetData></worksheet>',
  };
  return writeZip(
    Object.entries(parts).map(([name, xml]) => ({
      name,
      data: Buffer.from(xml, "utf8"),
      method: 8,
    })),
  );
}

/** The workbook the code actually PATCHed back to Drive. */
function uploadedWorkbook() {
  const upload = calls.find(
    (call) => call.url.includes("/upload/drive/v3/files/") && call.method === "PATCH",
  );
  if (!upload) throw new Error("no workbook was uploaded");
  return readZip(Buffer.from(upload.body as Uint8Array));
}

const OSM_DENTIST = makeDentist({
  id: "osm:node/1",
  name: "Irvine Family Dental",
  shortAddress: "123 Main St, Irvine, CA 92618",
  phone: "+1 949-555-0100",
  website: "https://example.com/",
  email: "hello@example.com",
  mapUrl: "https://www.openstreetmap.org/node/1",
  source: "osm",
});

const GOOGLE_DENTIST = makeDentist({
  id: "google:ChIJ1",
  name: "Irvine Dental Group",
  shortAddress: "123 Main St, Irvine, CA 92618",
  phone: "+1 949-555-1234",
  website: "https://www.irvinedentalgroup.com",
  currentOpen: true,
  mapUrl: "https://www.google.com/maps/place/?q=place_id:ChIJ1",
  source: "google",
  rating: 4.8,
  reviews: 247,
  businessStatus: "OPERATIONAL",
});

/**
 * The PMS column closes every sheet tab, whichever provider it belongs to. A
 * tab's header is written once and every later append has to line up under
 * it, so the column exists from the start and stays empty until a scan fills it.
 */
const PMS_HEADERS = ["PMS"];

/** What that column looks like for a dentist that has not been scanned. */
const PMS_EMPTY = PMS_HEADERS.map(() => "");

describe("sheetColumnsFor", () => {
  it("gives each tab the columns its provider can fill", () => {
    expect(sheetColumnsFor("osm").map((c) => c.header)).toEqual([
      "Name",
      "Address",
      "Phone",
      "Email",
      "Website",
      "Map URL",
      "Search ZIP",
      ...PMS_HEADERS,
    ]);
    expect(sheetColumnsFor("google").map((c) => c.header)).toEqual([
      "Name",
      "Address",
      "Phone",
      "Website",
      "Rating",
      "Reviews",
      "Open Now",
      "Business Status",
      "Map URL",
      "Search ZIP",
      ...PMS_HEADERS,
    ]);
  });

  it("does not vary with the results, unlike a file export", () => {
    /*
     * This is the whole reason the sheet uses a different rule. A tab's header
     * is written once; if the columns followed the data, the first search that
     * happened to return no email would shift every later row one column left.
     */
    expect(sheetColumnsFor("osm").map((c) => c.header)).toContain("Email");
    expect(sheetColumnsFor("google").map((c) => c.header)).toContain("Rating");
  });
});

describe("toSheetRows", () => {
  it("produces one cell per column, in order", () => {
    const [row] = toSheetRows([GOOGLE_DENTIST], "google", CONTEXT);
    expect(row).toEqual([
      "Irvine Dental Group",
      "123 Main St, Irvine, CA 92618",
      "+1 949-555-1234",
      "https://www.irvinedentalgroup.com",
      4.8,
      247,
      "Yes",
      "OPERATIONAL",
      "https://www.google.com/maps/place/?q=place_id:ChIJ1",
      "92618",
      // Unscanned, so every PMS cell is empty rather than a placeholder.
      ...PMS_EMPTY,
    ]);
  });

  it("keeps numbers as numbers, so the sheet can sort them", () => {
    const [row] = toSheetRows([GOOGLE_DENTIST], "google", CONTEXT);
    expect(typeof row[4]).toBe("number");
    expect(typeof row[5]).toBe("number");
  });

  it("writes an empty cell for a value the source did not have", () => {
    const bare = makeDentist({ id: "osm:node/2", name: "Bare", source: "osm" });
    expect(toSheetRows([bare], "osm", CONTEXT)).toEqual([
      ["Bare", "", "", "", "", "", "92618", ...PMS_EMPTY],
    ]);
  });

  it("gives every row the same width as its header", () => {
    const rows = toSheetRows([OSM_DENTIST, makeDentist()], "osm", CONTEXT);
    for (const row of rows) {
      expect(row).toHaveLength(sheetColumnsFor("osm").length);
    }
  });
});

describe("buildAssertion", () => {
  it("signs a JWT Google can verify", () => {
    const [header, claims, signature] = buildAssertion(CONFIG, 1_700_000_000).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(signature.length).toBeGreaterThan(0);

    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toMatchObject({
      iss: CONFIG.clientEmail,
      scope:
        "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it("reports a malformed key as a configuration problem", () => {
    expect(() =>
      buildAssertion({ ...CONFIG, privateKey: "-----BEGIN PRIVATE KEY-----junk" }),
    ).toThrow(ConfigurationError);
  });
});

describe("getAccessToken", () => {
  it("exchanges the assertion for a token", async () => {
    stubSheets();
    await expect(getAccessToken(CONFIG)).resolves.toBe("test-token");

    const call = callTo("oauth2.googleapis.com/token");
    expect(call?.method).toBe("POST");
    expect(String(call?.body)).toContain("grant_type=urn");
  });

  it("reuses a token rather than minting one per click", async () => {
    stubSheets();
    await getAccessToken(CONFIG);
    await getAccessToken(CONFIG);
    expect(calls.filter((c) => c.url.includes("/token"))).toHaveLength(1);
  });

  it("passes Google's own refusal through", async () => {
    fetchMock.mockResolvedValue(
      json({
        error: "invalid_grant",
        error_description: "Invalid JWT Signature.",
      }),
    );
    await expect(getAccessToken(CONFIG)).rejects.toThrow(/Invalid JWT Signature/);
  });

  it("never puts the private key in the error", async () => {
    fetchMock.mockResolvedValue(json({ error: "invalid_grant" }));
    await expect(getAccessToken(CONFIG)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("BEGIN PRIVATE KEY"),
      }),
    );
  });
});

describe("appendDentistsToSheet", () => {
  it("appends OSM results to the osm tab", async () => {
    stubSheets();
    const result = await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);

    expect(result).toMatchObject({ tab: "osm", appendedRows: 1 });
    const append = callTo(":append", "POST");
    expect(append?.url).toContain("/values/osm!A1:append");
    expect(append?.body).toEqual({
      values: [
        [
          "Irvine Family Dental",
          "123 Main St, Irvine, CA 92618",
          "+1 949-555-0100",
          "hello@example.com",
          "https://example.com/",
          "https://www.openstreetmap.org/node/1",
          "92618",
          ...PMS_EMPTY,
        ],
      ],
    });
  });

  it("appends Google results to the google tab", async () => {
    stubSheets();
    const result = await appendDentistsToSheet(CONFIG, "google", [GOOGLE_DENTIST], CONTEXT);

    expect(result.tab).toBe("google");
    expect(callTo(":append", "POST")?.url).toContain("/values/google!A1:append");
  });

  it("inserts rows rather than overwriting what is already there", async () => {
    stubSheets();
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);
    expect(callTo(":append", "POST")?.url).toContain("insertDataOption=INSERT_ROWS");
  });

  it("sends values raw, so a phone number is not read as a formula", async () => {
    stubSheets();
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);
    expect(callTo(":append", "POST")?.url).toContain("valueInputOption=RAW");
  });

  it("creates the tab when the spreadsheet does not have it", async () => {
    stubSheets({ tabs: ["Sheet1"], headerRow: null });
    const result = await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);

    expect(result.createdTab).toBe(true);
    expect(callTo(":batchUpdate")?.body).toEqual({
      requests: [{ addSheet: { properties: { title: "osm" } } }],
    });
  });

  it("writes the header row into an empty tab", async () => {
    stubSheets({ headerRow: null });
    const result = await appendDentistsToSheet(CONFIG, "google", [GOOGLE_DENTIST], CONTEXT);

    expect(result.wroteHeader).toBe(true);
    expect(callTo("A1:Z1", "PUT")?.body).toEqual({
      values: [
        [
          "Name",
          "Address",
          "Phone",
          "Website",
          "Rating",
          "Reviews",
          "Open Now",
          "Business Status",
          "Map URL",
          "Search ZIP",
          ...PMS_HEADERS,
        ],
      ],
    });
  });

  it("leaves an existing header alone", async () => {
    stubSheets({ headerRow: ["Name", "Address"] });
    const result = await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);

    expect(result.wroteHeader).toBe(false);
    expect(callTo("A1:Z1", "PUT")).toBeUndefined();
  });

  it("does not call append for an empty result set", async () => {
    stubSheets();
    const result = await appendDentistsToSheet(CONFIG, "osm", [], CONTEXT);
    expect(result.appendedRows).toBe(0);
    expect(callTo(":append", "POST")).toBeUndefined();
  });

  it("blames sharing when Drive refuses access", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ error: { message: "The caller does not have permission" } }, 403);
    });

    await expect(
      appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT),
    ).rejects.toThrow(/Share the spreadsheet with the service account as an Editor/);
  });

  it("refuses read-only access with the reason, not a 403 later on", async () => {
    // Viewer access reads perfectly well and fails only on write, which is a
    // confusing place to discover it.
    stubSheets({ canEdit: false });
    await expect(
      appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT),
    ).rejects.toThrow(/as an Editor rather than a Viewer/);
  });

  it("tells the user about the spreadsheet, not about the search service", async () => {
    // The message the browser shows. A failed save that blames the search
    // sends someone to look in entirely the wrong place.
    stubSheets({ canEdit: false });
    await expect(
      appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT),
    ).rejects.toMatchObject({
      publicMessage: expect.stringContaining("spreadsheet"),
    });
    await expect(
      appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT),
    ).rejects.toMatchObject({
      publicMessage: expect.not.stringContaining("search service"),
    });
  });

  it("writes into an uploaded .xlsx through Drive instead of failing", async () => {
    /*
     * The case that started all this: a spreadsheet at a /spreadsheets/ URL
     * that is really a Drive-hosted Office file. The Sheets API cannot write a
     * cell into one, so the workbook is fetched, edited and written back to the
     * same file id - the link the user already has keeps working.
     */
    stubSheets({ mimeType: XLSX_MIME, workbook: officeWorkbook() });

    const result = await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);
    expect(result).toMatchObject({ mode: "office", tab: "osm", appendedRows: 1 });

    // Written back to the same id, and never through the Sheets API.
    const upload = callTo("/upload/drive/v3/files/", "PATCH");
    expect(upload?.url).toContain("1jT4QLtest");
    expect(callTo(":append")).toBeUndefined();
  });

  it("puts the rows in the workbook it uploads", async () => {
    stubSheets({ mimeType: XLSX_MIME, workbook: officeWorkbook() });
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);

    const uploaded = uploadedWorkbook();
    const sheet = uploaded.find((m) => m.name === "xl/worksheets/sheet1.xml");
    expect(sheet?.data.toString()).toContain("Irvine Family Dental");
  });

  it("leaves the rest of that workbook alone", async () => {
    stubSheets({ mimeType: XLSX_MIME, workbook: officeWorkbook() });
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);

    const original = new Map(readZip(officeWorkbook()).map((m) => [m.name, m.data]));
    for (const member of uploadedWorkbook()) {
      if (member.name === "xl/worksheets/sheet1.xml") continue;
      expect(member.data.equals(original.get(member.name)!), member.name).toBe(true);
    }
  });

  it("says which tabs exist when the workbook lacks the one needed", async () => {
    stubSheets({ mimeType: XLSX_MIME, workbook: officeWorkbook() });
    await expect(
      appendDentistsToSheet(CONFIG, "google", [GOOGLE_DENTIST], CONTEXT),
    ).rejects.toThrow(/no tab named "google".*osm/);
  });

  it("checks the spreadsheet without needing any results", async () => {
    /*
     * What makes the fast path possible: the route calls this before running
     * the search, so a spreadsheet it cannot write to costs a second rather
     * than a full Overpass query whose results are then discarded.
     */
    stubSheets({ headerRow: null });
    const target = await ensureSheetReady(CONFIG, "google");

    expect(target).toMatchObject({ tab: "google", wroteHeader: true });
    expect(callTo(":append", "POST")).toBeUndefined();
  });

  it("reports a configuration failure rather than a retryable one", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ error: { message: "Requested entity was not found." } }, 404);
    });

    await expect(
      appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe("the Search ZIP column in the sheet", () => {
  /** The cell index the Search ZIP occupies: last of the dentist columns. */
  const zipIndex = (provider: "osm" | "google"): number =>
    sheetColumnsFor(provider).findIndex((column) => column.header === "Search ZIP");

  it("closes the dentist columns, so a shared sheet records the search", async () => {
    stubSheets();
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], { zip: "60601" });

    const values = (callTo(":append", "POST")?.body as { values: unknown[][] })
      .values;
    expect(values[0][zipIndex("osm")]).toBe("60601");
  });

  it("keeps a leading zero as text", async () => {
    stubSheets();
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], { zip: "02134" });

    const values = (callTo(":append", "POST")?.body as { values: unknown[][] })
      .values;
    expect(values[0][zipIndex("osm")]).toBe("02134");
  });

  it("appears in the header the tab is created with", async () => {
    stubSheets({ headerRow: null });
    await appendDentistsToSheet(CONFIG, "osm", [OSM_DENTIST], CONTEXT);

    const header = (callTo("A1:Z1", "PUT")?.body as { values: string[][] })
      .values[0];
    expect(header[zipIndex("osm")]).toBe("Search ZIP");
    // The PMS column follows it, so the row width is stable from day one.
    expect(header.at(-1)).toBe("PMS");
  });
});

describe("sheets configuration", () => {
  const ENV = {
    SHEETS_SPREADSHEET_ID: "1jT4QLtest",
    SHEETS_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
    SHEETS_PRIVATE_KEY: privateKey,
  };

  it("is off by default, so the app runs without any of it", () => {
    expect(loadConfig({}).sheets).toBeNull();
    expect(isSheetsConfigured({})).toBe(false);
  });

  it("reads all three values together", () => {
    expect(loadConfig(ENV).sheets).toMatchObject({
      spreadsheetId: "1jT4QLtest",
      clientEmail: "sa@example.iam.gserviceaccount.com",
    });
    expect(isSheetsConfigured(ENV)).toBe(true);
  });

  it("refuses a half-configured integration", () => {
    // Otherwise it fails at the first click rather than at startup.
    expect(() =>
      loadConfig({ SHEETS_SPREADSHEET_ID: "1jT4QLtest" }),
    ).toThrow(ConfigurationError);
    expect(isSheetsConfigured({ SHEETS_SPREADSHEET_ID: "1jT4QLtest" })).toBe(false);
  });

  it("restores the newlines a .env file cannot hold", () => {
    const escaped = privateKey.split("\n").join("\\n");
    expect(escaped).not.toContain("\n");

    const config = loadConfig({ ...ENV, SHEETS_PRIVATE_KEY: escaped });
    expect(config.sheets?.privateKey).toBe(privateKey);
  });

  it("rejects a value that is not a PEM key at all", () => {
    expect(() =>
      loadConfig({ ...ENV, SHEETS_PRIVATE_KEY: "not-a-key" }),
    ).toThrow(/PEM private key/);
  });
});

describe("diagnoseSheets", () => {
  it("stops at the unset configuration and says to restart", async () => {
    // Environment changes are not hot-reloaded, which is a common way to spend
    // ten minutes on a setting that was already correct.
    const result = await diagnoseSheets();
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ step: "Environment variables", ok: false });
    expect(result.steps[0].fix).toMatch(/restart the dev server/);
  });

  it("reports an Office file as workable, through Drive", async () => {
    vi.stubEnv("SHEETS_SPREADSHEET_ID", "1jT4QLtest");
    vi.stubEnv("SHEETS_CLIENT_EMAIL", "sa@example.iam.gserviceaccount.com");
    vi.stubEnv("SHEETS_PRIVATE_KEY", privateKey);

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/token")) return json({ access_token: "t", expires_in: 3600 });
      return json(
        { error: { message: "The document must not be an Office file." } },
        400,
      );
    });

    const result = await diagnoseSheets();
    expect(result.ok).toBe(true);

    const step = result.steps.find((entry) => entry.step === "Open the spreadsheet");
    expect(step?.ok).toBe(true);
    expect(step?.detail).toMatch(/Drive API/);

    vi.unstubAllEnvs();
  });

  it("reports a working setup step by step", async () => {
    vi.stubEnv("SHEETS_SPREADSHEET_ID", "1jT4QLtest");
    vi.stubEnv("SHEETS_CLIENT_EMAIL", "sa@example.iam.gserviceaccount.com");
    vi.stubEnv("SHEETS_PRIVATE_KEY", privateKey);

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({
        properties: { title: "Dentist Finder" },
        sheets: [{ properties: { title: "osm" } }, { properties: { title: "google" } }],
      });
    });

    const result = await diagnoseSheets();
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      "Environment variables",
      "Service-account credentials",
      "Open the spreadsheet",
      "Tabs",
    ]);

    vi.unstubAllEnvs();
  });

  it("blames sharing, not the id, for a 403", async () => {
    vi.stubEnv("SHEETS_SPREADSHEET_ID", "1jT4QLtest");
    vi.stubEnv("SHEETS_CLIENT_EMAIL", "sa@example.iam.gserviceaccount.com");
    vi.stubEnv("SHEETS_PRIVATE_KEY", privateKey);

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ error: { message: "The caller does not have permission" } }, 403);
    });

    const failed = (await diagnoseSheets()).steps.find((step) => !step.ok);
    expect(failed?.fix).toMatch(/Share the spreadsheet with sa@example/);

    vi.unstubAllEnvs();
  });
});
