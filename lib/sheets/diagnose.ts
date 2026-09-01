/**
 * Setup diagnosis for the Google Sheets destination.
 *
 * Four things have to be true before a save can work, and when one is missing
 * the failure arrives as a single opaque HTTP error. This walks them in order
 * and stops at the first one that fails, so the answer is "step 3, and here is
 * what to do" rather than "FAILED_PRECONDITION".
 *
 * Server-only, and only ever reachable outside production - it reports on
 * configuration, which is nobody else's business.
 */
import { GOOGLE_SHEETS_API_BASE, SHEETS_TIMEOUT_MS, SHEET_TAB_NAMES } from "@/lib/constants";
import { loadConfig, type SheetsConfig } from "@/lib/config";
import { describeCause, HttpStatusError, parseJson, requestText } from "@/lib/providers/http";
import { getAccessToken } from "@/lib/sheets/auth";

export interface DiagnosisStep {
  step: string;
  ok: boolean;
  detail: string;
  /** What to do about it. Absent when the step passed. */
  fix?: string;
}

export interface SheetsDiagnosis {
  ok: boolean;
  steps: DiagnosisStep[];
}

interface SpreadsheetMeta {
  properties?: { title?: string };
  sheets?: { properties?: { title?: string } }[];
}

function pass(step: string, detail: string): DiagnosisStep {
  return { step, ok: true, detail };
}

function fail(step: string, detail: string, fix: string): DiagnosisStep {
  return { step, ok: false, detail, fix };
}

/** Reads the config without throwing, so a bad setup is reported not crashed. */
function readConfig(): { config: SheetsConfig | null; error: string | null } {
  try {
    return { config: loadConfig().sheets, error: null };
  } catch (error) {
    return { config: null, error: describeCause(error) };
  }
}

export async function diagnoseSheets(): Promise<SheetsDiagnosis> {
  const steps: DiagnosisStep[] = [];
  const done = (): SheetsDiagnosis => ({
    ok: steps.every((entry) => entry.ok),
    steps,
  });

  /* 1. Configuration ------------------------------------------------------ */
  const { config, error } = readConfig();
  if (error) {
    steps.push(
      fail("Environment variables", error, "Set all three SHEETS_* variables, or none."),
    );
    return done();
  }
  if (!config) {
    steps.push(
      fail(
        "Environment variables",
        "SHEETS_SPREADSHEET_ID, SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY are unset.",
        "Add them to .env.local, then restart the dev server - environment changes are not hot-reloaded.",
      ),
    );
    return done();
  }
  steps.push(
    pass(
      "Environment variables",
      `Spreadsheet ${config.spreadsheetId}, service account ${config.clientEmail}.`,
    ),
  );

  /* 2. Credentials -------------------------------------------------------- */
  let token: string;
  try {
    token = await getAccessToken(config);
    steps.push(pass("Service-account credentials", "Google issued an access token."));
  } catch (authError) {
    steps.push(
      fail(
        "Service-account credentials",
        describeCause(authError),
        "Check SHEETS_CLIENT_EMAIL and SHEETS_PRIVATE_KEY against the service-account JSON, and enable the Google Sheets API for the project.",
      ),
    );
    return done();
  }

  /* 3. The document itself ------------------------------------------------ */
  let meta: SpreadsheetMeta;
  try {
    const text = await requestText(
      `${GOOGLE_SHEETS_API_BASE}/${config.spreadsheetId}?fields=properties.title,sheets.properties.title`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeoutMs: SHEETS_TIMEOUT_MS,
        label: "Google Sheets",
      },
    );
    meta = parseJson<SpreadsheetMeta>(text, "Google Sheets");
  } catch (openError) {
    const body = openError instanceof HttpStatusError ? openError.bodySnippet : "";
    const status = openError instanceof HttpStatusError ? openError.status : 0;

    if (/must not be an Office file|not supported for this document/i.test(body)) {
      // Not fatal any more: the Drive path handles this document type.
      steps.push(
        pass(
          "Open the spreadsheet",
          "An uploaded .xlsx workbook. The Sheets API cannot write into it, so saves go through the Drive API instead, rewriting the file in place at the same link.",
        ),
      );
      return done();
    } else if (status === 403) {
      steps.push(
        fail(
          "Open the spreadsheet",
          body || "Access denied.",
          `Share the spreadsheet with ${config.clientEmail} as an Editor.`,
        ),
      );
    } else {
      steps.push(
        fail(
          "Open the spreadsheet",
          body || describeCause(openError),
          "Check SHEETS_SPREADSHEET_ID - it is the part of the URL between /d/ and /edit.",
        ),
      );
    }
    return done();
  }

  steps.push(
    pass(
      "Open the spreadsheet",
      `Opened "${meta.properties?.title ?? "(untitled)"}" as a native Google Sheet.`,
    ),
  );

  /* 4. Tabs --------------------------------------------------------------- */
  const titles = (meta.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => Boolean(title));
  const expected = Object.values(SHEET_TAB_NAMES);
  const missing = expected.filter((tab) => !titles.includes(tab));

  steps.push(
    pass(
      "Tabs",
      missing.length === 0
        ? `Both tabs exist: ${expected.join(", ")}.`
        : `Tabs present: ${titles.join(", ") || "none"}. Missing ${missing.join(", ")}, which will be created on the first save.`,
    ),
  );

  return done();
}
