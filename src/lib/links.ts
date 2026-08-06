/**
 * Resolving a listing to something clickable.
 *
 * Not every row has a canonical ad URL — manually-logged trucks and listings
 * whose alert email buried the link behind a tracking redirect both end up
 * with `listing_url = NULL`. Rendering nothing leaves a dead-end card: a
 * truck you can see but can't go look at.
 *
 * When we don't have the ad, we build a search. Two rules keep that search
 * from being useless:
 *   1. Scope it to the site the listing came from (`site:truecar.com`), so
 *      it returns the actual ad rather than a page of dealer marketing.
 *   2. Use terms a listing page actually contains. Mileage rendered as
 *      "45,837 miles" is a worse search term than the bare number, and the
 *      comma just fragments the query.
 *
 * And the label says what the link really is. A search is never presented as
 * "the ad" — it says "Search TrueCar", because that is all it can honestly
 * promise. Whether the ad is indexed is out of our hands; the real fix is
 * capturing listing_url at ingest, which is why manually-logged rows should
 * always be entered with their URL.
 */

export interface ListingLink {
  href: string;
  label: string;
  /** true = the actual ad; false = a search that should surface it */
  isExact: boolean;
}

interface LinkableListing {
  year?: number | null;
  trim?: string | null;
  mileage?: number | null;
  vin?: string | null;
  dealer_name?: string | null;
  dealer_location?: string | null;
  listing_url?: string | null;
  source?: string | null;
}

/** Where each source publishes its listings, for `site:` scoping. */
const SOURCE_SITES: Record<string, { domain: string; name: string }> = {
  truecar: { domain: "truecar.com", name: "TrueCar" },
  cars: { domain: "cars.com", name: "Cars.com" },
  cargurus: { domain: "cargurus.com", name: "CarGurus" },
  carmax: { domain: "carmax.com", name: "CarMax" },
  carvana: { domain: "carvana.com", name: "Carvana" },
  autotrader: { domain: "autotrader.com", name: "Autotrader" },
  autotempest: { domain: "autotempest.com", name: "AutoTempest" },
};

function siteFor(source: string | null | undefined) {
  if (!source) return null;
  // `source` can be a comma-joined list once a truck is seen on two platforms.
  const first = String(source).split(",")[0].trim().toLowerCase();
  return SOURCE_SITES[first] ?? null;
}

export function listingLink(l: LinkableListing): ListingLink {
  const url = l.listing_url;
  if (url && /^https?:\/\//i.test(url)) {
    return { href: url, label: "Open listing", isExact: true };
  }

  const site = siteFor(l.source);

  // A VIN identifies exactly one truck — nothing else comes close.
  if (l.vin) {
    const q = site ? `${l.vin} site:${site.domain}` : l.vin;
    return {
      href: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      label: site ? `Search ${site.name} by VIN` : "Search by VIN",
      isExact: false,
    };
  }

  // No VIN: year + trim + city, scoped to the source site. Mileage goes in
  // unformatted — listing pages write "45,837" but Google tokenises the bare
  // number better, and the comma only splits the phrase.
  const terms = [
    l.year ? String(l.year) : null,
    "Toyota Tacoma",
    l.trim || null,
    l.mileage ? String(l.mileage) : null,
    l.dealer_location || l.dealer_name || null,
  ].filter(Boolean);

  if (site) terms.push(`site:${site.domain}`);

  return {
    href: `https://www.google.com/search?q=${encodeURIComponent(terms.join(" "))}`,
    label: site ? `Search ${site.name}` : "Web search",
    isExact: false,
  };
}
