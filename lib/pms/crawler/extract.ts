/**
 * Pulls the navigable and embedded parts out of one HTML page.
 *
 * Links are the raw material of a patient journey, and they hide in more than
 * `<a href>`: buttons with data attributes, `onclick` handlers that assign
 * `location.href`, inline scripts that open a booking window, meta refreshes.
 * All of those are read as *text* - a URL literal is extracted by pattern,
 * never by running the script - and resolved against the page.
 *
 * Also collected: forms with their labels and destinations, script sources,
 * iframe sources, and a rough judgement of whether the page is an empty
 * JavaScript shell.
 */
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { PMS_MAX_INLINE_SCRIPT_URLS } from "@/lib/pms/constants";
import { resolveUrl } from "@/lib/pms/crawler/url";

export interface LinkArtifact {
  url: string;
  /** Visible text, collapsed. */
  text: string;
  /** Accessible name, title, image alt: what the element is *about*. */
  context: string;
  inNavigation: boolean;
}

export interface FormInput {
  name: string | null;
  placeholder: string | null;
}

export interface FormArtifact {
  /** Absolute destination, or null when the form posts back to its own page. */
  action: string | null;
  inputs: FormInput[];
  labels: string[];
  buttons: string[];
  /** Visible text inside the form, capped. */
  text: string;
}

export interface PageExtraction {
  links: LinkArtifact[];
  forms: FormArtifact[];
  /** Script sources, absolute. */
  scripts: string[];
  /** Absolute URL literals found inside inline scripts. */
  inlineScriptUrls: string[];
  /** Iframe sources, absolute. */
  iframes: string[];
  /** True when the page looks like a shell that only renders with JavaScript. */
  jsHeavy: boolean;
}

/** Attributes sites use to carry a destination on non-anchor elements. */
const URL_ATTRIBUTES = [
  "data-url",
  "data-href",
  "data-link",
  "data-target",
  "data-booking-url",
  "data-appointment-url",
  "data-schedule-url",
  "data-scheduling-url",
  "data-portal-url",
  "data-redirect",
];

/**
 * Navigation statements whose argument is a string literal. Only literals are
 * taken; an expression is opaque without executing it, which is never done.
 */
const NAVIGATION_PATTERN =
  /(?:window\.open|(?:window\.|document\.|top\.|self\.)?location(?:\.href|\.assign|\.replace)?)\s*(?:\(|=)\s*["'`]([^"'`\s]+)["'`]/g;

const URL_LITERAL_PATTERN = /https?:\/\/[^\s"'`<>\\)}\]]+/g;

const TEXT_CAP = 200;
const FORM_TEXT_CAP = 300;

const NAVIGATION_SELECTOR =
  "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo], .nav, .navbar, .menu, .footer, .site-header, .site-footer";

function collapse(text: string | null | undefined, cap = TEXT_CAP): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
}

/** Whether a data attribute value is a destination rather than a selector. */
function looksLikeDestination(value: string): boolean {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("//")) return true;
  return trimmed.startsWith("/") && !trimmed.startsWith("//") && trimmed.length > 1;
}

function accessibleName($el: Cheerio<AnyNode>): string {
  const parts = [
    $el.attr("aria-label"),
    $el.attr("title"),
    $el.find("img[alt]").first().attr("alt"),
  ];
  return collapse(parts.filter(Boolean).join(" "));
}

function inNavigation($el: Cheerio<AnyNode>): boolean {
  return $el.closest(NAVIGATION_SELECTOR).length > 0;
}

function parseRefresh(content: string): string | null {
  const match = /url\s*=\s*['"]?([^'";]+)/i.exec(content);
  return match ? match[1].trim() : null;
}

export function extractPage(html: string, pageUrl: string): PageExtraction {
  const $: CheerioAPI = load(html);
  const links: LinkArtifact[] = [];

  const pushLink = (
    raw: string | null | undefined,
    text: string,
    context: string,
    navigation: boolean,
  ): void => {
    const url = resolveUrl(pageUrl, raw);
    if (!url) return;
    links.push({ url, text: collapse(text), context, inNavigation: navigation });
  };

  /* Anchors and image maps ------------------------------------------------ */
  $("a[href], area[href]").each((_, element) => {
    const $el = $(element);
    pushLink($el.attr("href"), $el.text(), accessibleName($el), inNavigation($el));
  });

  /* Buttons and anything else carrying a destination ---------------------- */
  const carriers = [...URL_ATTRIBUTES.map((name) => `[${name}]`), "[onclick]"].join(",");
  $(carriers).each((_, element) => {
    const $el = $(element);
    const text = $el.text();
    const context = accessibleName($el);
    const navigation = inNavigation($el);

    for (const name of URL_ATTRIBUTES) {
      const value = $el.attr(name);
      if (value && looksLikeDestination(value)) {
        pushLink(value, text, context, navigation);
      }
    }

    const onclick = $el.attr("onclick");
    if (onclick) {
      for (const match of onclick.matchAll(NAVIGATION_PATTERN)) {
        pushLink(match[1], text, context, navigation);
      }
    }
  });

  /* Forms ----------------------------------------------------------------- */
  const forms: FormArtifact[] = [];
  $("form").each((_, element) => {
    const $form = $(element);
    const inputs: FormInput[] = [];
    $form.find("input, select, textarea").each((__, field) => {
      const $field = $(field);
      inputs.push({
        name: $field.attr("name") ?? null,
        placeholder: $field.attr("placeholder") ?? null,
      });
    });
    const labels: string[] = [];
    $form.find("label, legend").each((__, label) => {
      const text = collapse($(label).text());
      if (text) labels.push(text);
    });
    const buttons: string[] = [];
    $form.find("button, input[type=submit], input[type=button], input[type=image]").each((__, button) => {
      const $button = $(button);
      const text = collapse($button.text() || $button.attr("value") || $button.attr("aria-label") || $button.attr("alt"));
      if (text) buttons.push(text);
    });

    forms.push({
      action: resolveUrl(pageUrl, $form.attr("action")),
      inputs,
      labels,
      buttons,
      text: collapse($form.text(), FORM_TEXT_CAP),
    });
  });

  /* Scripts --------------------------------------------------------------- */
  const scripts: string[] = [];
  $("script[src]").each((_, element) => {
    const src = resolveUrl(pageUrl, $(element).attr("src"));
    if (src) scripts.push(src);
  });

  const inlineUrls = new Set<string>();
  $("script:not([src])").each((_, element) => {
    const code = $(element).text();
    if (!code) return;
    for (const match of code.matchAll(NAVIGATION_PATTERN)) {
      pushLink(match[1], "", "", false);
    }
    for (const match of code.matchAll(URL_LITERAL_PATTERN)) {
      if (inlineUrls.size >= PMS_MAX_INLINE_SCRIPT_URLS) break;
      const url = resolveUrl(pageUrl, match[0].replace(/[.,;:]+$/, ""));
      if (url) inlineUrls.add(url);
    }
  });

  /* Iframes --------------------------------------------------------------- */
  const iframes: string[] = [];
  $("iframe").each((_, element) => {
    const $frame = $(element);
    const src = resolveUrl(pageUrl, $frame.attr("src") ?? $frame.attr("data-src"));
    if (src) iframes.push(src);
  });

  /* Meta refresh ---------------------------------------------------------- */
  $("meta[http-equiv]").each((_, element) => {
    const $meta = $(element);
    if (($meta.attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
    pushLink(parseRefresh($meta.attr("content") ?? ""), "", "meta refresh", false);
  });

  /* The JavaScript-shell heuristic ---------------------------------------- */
  const noscript = collapse($("noscript").text(), 500);
  const bodyChildren = $("body").children().length;
  const hasAppRoot = $("#root, #__next, #app, #___gatsby, [data-reactroot]").length > 0;

  $("script, style, noscript, template, svg").remove();
  const text = collapse($("body").text(), 20_000);

  const anchorCount = $("a[href], area[href]").length;
  const warnsAboutJavaScript = /enable javascript|requires? javascript|javascript is (disabled|required)|need to enable javascript/i.test(noscript);
  /*
   * "This page only exists once JavaScript runs" needs positive evidence, not
   * merely a short page: a small practice site with two links and a paragraph
   * of text has been read perfectly well. So it takes a single-page-app root,
   * an explicit noscript warning, or a body that is scripts and nothing else.
   */
  const jsHeavy =
    (hasAppRoot && bodyChildren <= 3 && text.length < 500) ||
    (warnsAboutJavaScript && anchorCount < 5) ||
    (anchorCount === 0 && text.length < 200 && scripts.length > 0);

  return {
    links,
    forms,
    scripts,
    inlineScriptUrls: [...inlineUrls],
    iframes,
    jsHeavy,
  };
}
