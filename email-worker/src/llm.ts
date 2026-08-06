// Claude-based email parser. One LLM call extracts every listing in the
// email, regardless of sender format. Prompt caching makes the system
// prompt near-free after the first call in a 5-minute window.

import { HUNT, criteriaSentence } from "../../hunt.config.ts";

const SYSTEM_PROMPT = `You parse car-listing alert emails for a buyer hunting a ${HUNT.vehicle.label}. The buyer's criteria are: ${criteriaSentence()}.

You are an EXTRACTOR, not a filter. Never omit a vehicle because it falls outside those criteria — the pipeline scores and filters downstream, and a listing you drop is invisible forever.

Given the raw email body (HTML or text), return ONLY a JSON object matching this shape:

{
  "kind": "listing_alert" | "verification" | "welcome" | "marketing" | "other",
  "listings": [
    {
      "year": number | null,
      "make": string | null,
      "model": string | null,
      "trim": string | null,
      "price": number | null,
      "mileage": number | null,
      "vin": string | null,
      "drivetrain": "4WD" | "2WD" | "AWD" | null,
      "cab_type": ${HUNT.vehicle.cabTypes.map((c) => `"${c}"`).join(" | ")} | null,
      "bed_size": ${HUNT.vehicle.bedSizes.map((b) => `"${b}"`).join(" | ")} | null,
      "color": string | null,
      "dealer_name": string | null,
      "dealer_location": string | null,
      "listing_url": string | null,
      "photo_url": string | null
    }
  ]
}

Rules:
- "kind" is "listing_alert" only if the email shows specific cars for sale. Verification/confirm-your-email = "verification". Generic newsletters/marketing = "marketing".
- Include EVERY listing shown, even other models, even 2WD, even over budget, even 100k miles. The pipeline filters later. Extract all of them, not just the first few.
- Extract VIN whenever present (17-char alphanumeric).
- price is integer USD (strip $, commas). Use null for "Call for price" / "Contact us" — do NOT invent or estimate a number.
- mileage is integer (strip "mi", commas).
- listing_url should be the click-through link to the specific vehicle's detail page. Strip tracking parameters when obvious.
- For trim, normalize punctuation and abbreviation variants to one canonical spelling (e.g. "TRD Off Road"/"TRD Off-Road"/"TRD OR" -> "TRD Off-Road"). Keep any "4x4"/"4WD"/"PreRunner" token that appears in the vehicle title inside the trim string — downstream code reads it.

drivetrain (IMPORTANT — never guess):
- Set "4WD" ONLY if the email explicitly says 4WD, 4x4, or Four Wheel Drive, or the trim is one that was never sold in two-wheel drive${HUNT.scoring.trimScores.length ? ` (for this search: ${HUNT.vehicle.fourWheelDriveOnlyTrims.map((r) => r.source.replace(/\\b|\\s\*/g, " ").trim()).join(", ")})` : ""}.
- Set "2WD" if it says 2WD, 4x2, RWD, Rear Wheel Drive, or PreRunner.
- Set "AWD" only if it explicitly says AWD / All Wheel Drive.
- If the email does not state the drivetrain, return null. A wrong 4WD is far more costly than an unknown one.

color:
- Extract the EXTERIOR color exactly as written ("Super White", "Ice Cap", "Magnetic Gray Metallic"). Do not return the interior color. If a two-tone string is given, put the exterior first.

photo_url (IMPORTANT):
- The main photograph OF THE ACTUAL TRUCK — the large hero/thumbnail image in that listing's block.
- Prefer a URL from an image CDN (e.g. images.cars.com, img2.carmax.com, inventory-photos, akamai, cloudfront) ending in .jpg/.jpeg/.png/.webp, or with sizing params.
- NEVER return: 1x1 tracking pixels, spacer.gif, logos, brand wordmarks, star-rating or badge icons, social-media icons, map images, or the listing page URL itself. A photo_url that equals listing_url is wrong — return null instead.
- If that listing block has no real vehicle photo, return null.

- Return strictly JSON, no markdown fences, no commentary.`;

export interface ParsedListing {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  price: number | null;
  mileage: number | null;
  vin: string | null;
  drivetrain: "4WD" | "2WD" | "AWD" | null;
  cab_type: string | null;
  bed_size: string | null;
  color: string | null;
  dealer_name: string | null;
  dealer_location: string | null;
  listing_url: string | null;
  photo_url: string | null;
}

export interface ParseResult {
  kind: "listing_alert" | "verification" | "welcome" | "marketing" | "other";
  listings: ParsedListing[];
}

/** Junk that dealers and ESPs pass off as images. */
const BAD_PHOTO_PATTERNS = [
  /spacer|pixel|1x1|blank\.(gif|png)|tracking|beacon|open\.aspx|\/o\.gif/i,
  /logo|wordmark|brandmark|icon|sprite|badge|star|social|facebook|twitter|instagram/i,
  /\.svg(\?|$)/i,
];

/** Drop photo_urls that are tracking junk or just the listing page again. */
function sanitizePhotoUrl(listing: ParsedListing): void {
  const url = listing.photo_url;
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    listing.photo_url = null;
    return;
  }
  if (listing.listing_url && url === listing.listing_url) {
    listing.photo_url = null;
    return;
  }
  if (BAD_PHOTO_PATTERNS.some((p) => p.test(url))) {
    listing.photo_url = null;
  }
}

export async function parseEmailWithClaude(
  apiKey: string,
  emailBody: string,
  emailSubject: string,
): Promise<{ result: ParseResult; raw: string }> {
  const trimmed = emailBody.length > 90_000 ? emailBody.slice(0, 90_000) : emailBody;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      // A 25-vehicle AutoTempest digest overflowed the old 4k ceiling, which
      // truncated the JSON and threw away the whole email.
      max_tokens: 16_000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Subject: ${emailSubject}\n\n---\n\n${trimmed}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";

  let parsed: ParseResult;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    const hint =
      data.stop_reason === "max_tokens"
        ? "response hit max_tokens (email too large) — "
        : "";
    throw new Error(`LLM returned non-JSON: ${hint}${text.slice(0, 300)}`);
  }

  if (!parsed.listings) parsed.listings = [];
  parsed.listings.forEach(sanitizePhotoUrl);
  return { result: parsed, raw: text };
}
