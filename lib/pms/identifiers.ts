/**
 * The competitors the detector can name, each with the domains that identify it.
 *
 * A URL names a vendor when its host is one of these domains or a subdomain of
 * one. That is the whole detection rule: a link, form action, iframe, script
 * or redirect hop pointing at `patientregistration.denticon.com` means
 * "Denticon". Nothing here reads page text.
 *
 * Only competitors belong here. Marketplaces and embeddable widgets that merely
 * present a practice (Zocdoc, LocalMed, Demandforce and the like) do not: they
 * say nothing about which system the practice runs, so they are not listed and
 * a URL pointing at them is ignored.
 *
 * Every domain was confirmed from the vendor's own site or a live practice
 * page; the note beside the non-obvious ones says what it hosts. A product
 * with no domain of its own is listed with none, so it is never guessed.
 */
import { hostMatchesDomain, hostOf } from "@/lib/pms/crawler/url";

export interface PmsIdentifier {
  name: string;
  /** Lower-case registrable domains. Subdomains match too. */
  domains: readonly string[];
  /** The vendor family this product belongs to. Not reported alongside the product. */
  family?: string;
}

export const PMS_IDENTIFIERS: readonly PmsIdentifier[] = [
  /* Patient-engagement platforms ------------------------------------------ */
  {
    name: "RevenueWell",
    // patientconnect365.com: patient portal; rwlogin.com: its sign-in service.
    domains: ["revenuewell.com", "patientconnect365.com", "rwlogin.com"],
  },
  {
    name: "Weave",
    // book.getweave.com hosts practices' online schedulers; app.getweave.com
    // is the Weave app and the Text Connect widget setup.
    domains: ["getweave.com"],
  },
  // app.nexhealth.com: online booking and forms.
  { name: "NexHealth", domains: ["nexhealth.com"] },
  // app.adit.com: practice app; static.adit.com: widget assets.
  { name: "Adit", domains: ["adit.com"] },
  // portal.dentalintel.com: practice login.
  { name: "Dental Intelligence", domains: ["dentalintel.com"] },
  // office.modento.io: practice app. Modento is now Dental Intelligence's
  // engagement product and modento.io redirects there, so both may be named.
  { name: "Modento", domains: ["modento.io"] },
  // my.yapiapp.com: practice login.
  { name: "Yapi", domains: ["yapiapp.com"] },
  // schedule.solutionreach.com: SR Schedule; prweb.solutionreach.com: PatientReach portal.
  { name: "Solutionreach", domains: ["solutionreach.com"] },
  // app.mangovoice.com: practice app.
  { name: "Mango Voice", domains: ["mangovoice.com"] },
  // flexbook.me hosts FlexSchedule booking pages (flexbook.me/<practice>), per the
  // Flex help centre article "FlexSchedule Settings"; auth.flexdental.co: practice sign-in.
  { name: "Flex Dental", domains: ["flex.dental", "flexdental.co", "flexbook.me"] },
  // Henry Schein One's patient-communication product; lh360.com is its short domain.
  { name: "Lighthouse 360", domains: ["lighthouse360.com", "lh360.com"] },

  /* Practice management systems ------------------------------------------- */
  // hub.dentrix.com: Dentrix Hub practice dashboard.
  { name: "Dentrix", domains: ["dentrix.com"] },
  // bookit.dentrixascend.com: online booking; live. and go.: practice login.
  { name: "Dentrix Ascend", domains: ["dentrixascend.com"] },
  // eaglesoftmobile.com: Eaglesoft Mobile staff app.
  { name: "Eaglesoft", domains: ["eaglesoft.net", "eaglesoftmobile.com"] },
  // patientviewer.com: Open Dental's hosted eServices - Web Sched online
  // booking (the page is titled "Web Sched"), Web Forms and the Patient Portal.
  // Its URLs look like patientviewer.com/?RSID=<registration key>&CID=<clinic>.
  { name: "Open Dental", domains: ["opendental.com", "patientviewer.com"] },
  {
    name: "Curve Dental",
    // curveconnex.com: patient portal; curvehero.com: practice login;
    // portal.curveapps.com: portal apps. dental4.me hosts Curve self-scheduling:
    // the practice picks the slug after the slash (dental4.me/<practice>), per
    // Curve Community "Updating the Self-Scheduling Clinic Configuration Settings".
    domains: ["curvedental.com", "curvehero.com", "curveconnex.com", "dental4.me", "curveapps.com"],
  },
  // patientregistration.denticon.com: forms; yourdentistoffice.com: portal and payments.
  {
    name: "Denticon",
    domains: ["denticon.com", "yourdentistoffice.com"],
    family: "Planet DDS",
  },
  // <practice>.carestack.com: patient portal and online appointments.
  { name: "CareStack", domains: ["carestack.com"] },
  // flow.dentimax.com: practice login.
  { name: "DentiMax", domains: ["dentimax.com"] },
  // patientbridge.gosensei.uk: patient portal.
  {
    name: "Sensei",
    domains: ["gosensei.com", "gosensei.co.uk", "gosensei.uk"],
    family: "Carestream Dental",
  },
  // portal.dental and dentr.net: patient portal and booking infrastructure.
  { name: "Dentally", domains: ["dentally.com", "dentally.co", "portal.dental", "dentr.net"] },
  // hellopatient.tab32.com: booking and forms.
  { name: "tab32", domains: ["tab32.com"] },
  { name: "Practice-Web", domains: ["practice-web.com"] },
  // Marketed under carestreamdental.com only; see "Carestream Dental" below.
  { name: "SoftDent", domains: [], family: "Carestream Dental" },
  // <practice>.oralhealth.app: online booking and portal; login.cleardent.ca: practice login.
  { name: "ClearDent", domains: ["cleardent.com", "cleardent.ca", "cleardent.app", "oralhealth.app"] },
  { name: "axiUm", domains: ["exansoftware.com", "axiumacademic.com"] },
  // Marketed under carestreamdental.com only; see "Carestream Dental" below.
  { name: "WinOMS", domains: [], family: "Carestream Dental" },
  // phiportal.com: patient portal.
  { name: "MacPractice", domains: ["macpractice.com", "phiportal.com"] },
  // <practice>.identalcloud.com: patient portal.
  { name: "iDentalSoft", domains: ["identalsoft.com", "identalcloud.com"] },
  // <practice>.cloud9ortho.com/portal: patient portal.
  {
    name: "Cloud 9",
    domains: ["cloud9software.com", "cloud9ortho.com"],
    family: "Planet DDS",
  },

  /* Vendor families: shared infrastructure that names the vendor, not the product */
  // booking.mytooth.io and form.mytooth.io serve both Denticon and Cloud 9 practices.
  { name: "Planet DDS", domains: ["planetdds.com", "mytooth.io"] },
  // patientforms.csdental.com serves Sensei, SoftDent and WinOMS practices.
  { name: "Carestream Dental", domains: ["carestreamdental.com", "csdental.com"] },
];

/** The vendor a URL points at, or null when its host names none of them. */
export function identifyUrl(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const identifier of PMS_IDENTIFIERS) {
    if (identifier.domains.some((domain) => hostMatchesDomain(host, domain))) {
      return identifier.name;
    }
  }
  return null;
}
