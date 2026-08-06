import type {
  ForwardableEmailMessage,
  ScheduledController,
  ExecutionContext,
  D1Database,
  R2Bucket,
  SendEmail,
} from "@cloudflare/workers-types";
import PostalMime from "postal-mime";
import { parseEmailWithClaude } from "./llm";
import {
  upsertListing,
  recordRawEmail,
  markRawEmailError,
  sourceFromSender,
  demoteRejectedListing,
} from "./db";
import { buildAndSendDigest } from "./digest";
import { checkHardFilters, isTargetVehicle, resolveDrivetrain } from "./filters";
import { decodeVins, isValidVin, vinFromUrl, type VinFacts } from "./vin";
import { capturePhoto } from "./photos";
import { replayBatch } from "./replay";
import { sweepInventory, criteriaFromEnv } from "./inventory";

export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  FORWARD: SendEmail;
  BUYER_EMAIL: string;
  DIGEST_FROM: string;
  BUYER_ZIP: string;
  MAX_DIST_MILES: string;
  ANTHROPIC_API_KEY: string;
  TRIGGER_TOKEN: string;
  /** Auto.dev inventory API. Absent = sweep disabled, email path unaffected. */
  AUTODEV_API_KEY?: string;
}

// Allowlist of senders we trust for the fast-path verification forward.
// Anyone NOT on this list goes through the LLM classifier — no free relay
// to BUYER_EMAIL via spoofable subject keywords.
const TRUSTED_VERIFY_SENDERS = [
  "carvana.com",
  "truecar.com",
  "truecarmail.com",
  "carmax.com",
  "email-carmax.com",
  "autotempest.com",
  "cars.com",
  "autotrader.com",
  "cargurus.com",
  "edmunds.com",
  "kbb.com",
];

const VERIFY_KEYWORDS = [
  "verify",
  "confirm your email",
  "confirm email",
  "activate your account",
  "welcome to",
  "please confirm",
  "email verification",
];

function senderDomain(fromAddr: string): string {
  const at = fromAddr.lastIndexOf("@");
  return at < 0 ? "" : fromAddr.slice(at + 1).toLowerCase();
}

function isTrustedSender(fromAddr: string): boolean {
  const host = senderDomain(fromAddr);
  return TRUSTED_VERIFY_SENDERS.some((d) => host === d || host.endsWith("." + d));
}

function looksLikeVerification(subject: string, fromAddr: string): boolean {
  // Only short-circuit to the gmail forward when BOTH the subject looks
  // verification-y AND the sender is a known platform. Untrusted senders
  // always go through the LLM classifier.
  if (!isTrustedSender(fromAddr)) return false;
  const s = subject.toLowerCase();
  return VERIFY_KEYWORDS.some((k) => s.includes(k));
}

/**
 * Flatten an HTML email into compact text that KEEPS image and link URLs.
 *
 * We parse the HTML part, not the text part. Alert emails from cars.com,
 * AutoTempest and CarGurus put every vehicle photo — and often several
 * vehicles entirely — in the HTML only; the text/plain alternative is a
 * stripped summary. Feeding the LLM the text part is why 577 of 585 rows
 * in D1 have no photo.
 *
 * Raw HTML would work too but burns ~5x the tokens on markup, so we strip
 * tags while preserving the two attributes that carry meaning.
 */
export function htmlToParseableText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!src) return " ";
      const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
      return ` [IMG ${src[1]}${alt && alt[1] ? ` alt="${alt[1]}"` : ""}] `;
    })
    .replace(/<a\b[^>]*>/gi, (tag) => {
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
      return href ? ` [LINK ${href[1]}] ` : " ";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|th|table|h[1-6]|li|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer HTML (has the photos); fall back to text if HTML is missing or empty. */
export function selectEmailBody(mime: { text?: string; html?: string }): string {
  const html = mime.html ? htmlToParseableText(mime.html) : "";
  if (html.length > 200) return html;
  return mime.text || html || mime.html || "";
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const fromAddr = message.from;
    const toAddr = message.to;
    const subject = message.headers.get("subject") || "";
    const messageId = message.headers.get("message-id");

    console.log(`[email] from=${fromAddr} subject=${subject.slice(0, 80)}`);

    // Always forward verification/welcome emails so the operator can finish signups.
    if (looksLikeVerification(subject, fromAddr)) {
      console.log("[email] forwarding verification to buyer");
      try {
        await message.forward(env.BUYER_EMAIL);
      } catch (err) {
        console.error("[email] forward failed", err);
      }
      return;
    }

    // Read the raw email and parse MIME.
    const reader = message.raw.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((a, c) => a + c.byteLength, 0);
    const rawBuf = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      rawBuf.set(c, off);
      off += c.byteLength;
    }

    const parsedMime = await PostalMime.parse(rawBuf);
    const body = selectEmailBody(parsedMime);

    const rawEmailId = await recordRawEmail(env.DB, {
      messageId,
      fromAddr,
      toAddr,
      subject,
      rawBody: body,
    });

    let llmResult;
    let llmRaw = "";
    try {
      const out = await parseEmailWithClaude(env.ANTHROPIC_API_KEY, body, subject);
      llmResult = out.result;
      llmRaw = out.raw;
    } catch (err: any) {
      console.error("[email] llm parse failed", err);
      await markRawEmailError(env.DB, rawEmailId, err.message || String(err));
      return;
    }

    // Verification/welcome detected by the LLM — forward.
    if (llmResult.kind === "verification" || llmResult.kind === "welcome") {
      console.log(`[email] llm classified as ${llmResult.kind} — forwarding`);
      try {
        await message.forward(env.BUYER_EMAIL);
      } catch (err) {
        console.error("[email] forward failed after llm classify", err);
      }
      return;
    }

    if (llmResult.kind !== "listing_alert" || llmResult.listings.length === 0) {
      console.log(`[email] kind=${llmResult.kind}, no listings — discarding`);
      await markRawEmailError(
        env.DB,
        rawEmailId,
        `non-listing: kind=${llmResult.kind}`,
        llmRaw,
      );
      return;
    }

    const source = sourceFromSender(fromAddr);
    let upsertedCount = 0;
    let photosStored = 0;
    const dropped = { offModel: 0, excludedColor: 0, twoWheelDrive: 0, incomplete: 0, error: 0 };

    // Recover VINs the email didn't state but its links carry (AutoTempest),
    // then decode every VIN in this email in ONE batch call. The VIN is the
    // only source that always knows the drivetrain.
    for (const l of llmResult.listings) {
      if (!isValidVin(l.vin)) {
        const recovered = vinFromUrl(l.listing_url);
        if (recovered) l.vin = recovered;
      }
    }
    let vinFacts = new Map<string, VinFacts>();
    try {
      vinFacts = await decodeVins(llmResult.listings.map((l) => l.vin || ""));
      if (vinFacts.size) console.log(`[email] decoded ${vinFacts.size} VIN(s) via vPIC`);
    } catch (err) {
      console.error("[email] VIN decode batch failed", err);
    }

    for (const listing of llmResult.listings) {
      const facts = listing.vin ? vinFacts.get(listing.vin.toUpperCase()) : undefined;

      // The VIN outranks the email on what this truck actually is.
      if (facts?.model && !/tacoma/i.test(facts.model)) {
        dropped.offModel++;
        console.log(`[email] VIN says ${facts.model}, not a Tacoma — dropping`);
        continue;
      }
      if (!isTargetVehicle(listing) && !facts?.model) {
        dropped.offModel++;
        continue;
      }
      if (facts?.trim && facts.trim.length > (listing.trim || "").length) {
        listing.trim = facts.trim;
      }
      // Cab and bed come off the VIN's config character, which is exact. The
      // email is a dealer's free text and loses to it — it used to only fill
      // the gaps, which left the email's guess in place when the two differed.
      if (facts?.cabType) listing.cab_type = facts.cabType;
      if (facts?.bedSize) listing.bed_size = facts.bedSize;

      // VIN-derived drivetrain wins; fall back to parsing the email text.
      const drivetrain = facts?.drivetrain ?? resolveDrivetrain(listing);
      const filter = checkHardFilters(listing, drivetrain);
      if (filter.rejected) {
        if (filter.reason === "color") dropped.excludedColor++;
        else dropped.twoWheelDrive++;
        // If we already stored this truck before the filters existed, retire it.
        try {
          const demotedId = await demoteRejectedListing(env.DB, listing, filter.reason!);
          if (demotedId) console.log(`[email] demoted id=${demotedId} reason=${filter.reason}`);
        } catch (err) {
          console.error("[email] demote failed", err);
        }
        continue;
      }

      try {
        const result = await upsertListing(
          env.DB,
          listing,
          drivetrain,
          source,
          fromAddr,
          rawEmailId,
        );
        if (!result) {
          dropped.incomplete++;
          continue;
        }
        upsertedCount++;

        // Persist the photo into R2 so it survives the listing being delisted.
        if (listing.photo_url && result.needsPhoto) {
          const stored = await capturePhoto(env.PHOTOS, result.listingId, listing.photo_url);
          if (stored) {
            await env.DB.prepare("UPDATE listings SET photos = ? WHERE id = ?")
              .bind(JSON.stringify([stored.path]), result.listingId)
              .run();
            photosStored++;
          }
        }

        const tag = result.isNew ? "NEW" : result.priceDropFrom ? "PRICE-DROP" : "SEEN";
        console.log(
          `[email] ${tag} id=${result.listingId} grade=${result.score.grade} score=${result.score.total} dt=${drivetrain ?? "unknown"}`,
        );
      } catch (err) {
        // One bad row must not abandon the rest of the email.
        dropped.error++;
        console.error("[email] upsert failed for listing", err);
      }
    }

    if (upsertedCount === 0) {
      await markRawEmailError(
        env.DB,
        rawEmailId,
        `no listings kept from ${llmResult.listings.length} parsed ` +
          `(offModel=${dropped.offModel} excludedColor=${dropped.excludedColor} 2wd=${dropped.twoWheelDrive} ` +
          `incomplete=${dropped.incomplete} error=${dropped.error})`,
        llmRaw,
      );
    }
    console.log(
      `[email] done: upserted=${upsertedCount} photos=${photosStored} total=${llmResult.listings.length} ` +
        `offModel=${dropped.offModel} excludedColor=${dropped.excludedColor} 2wd=${dropped.twoWheelDrive} ` +
        `incomplete=${dropped.incomplete} error=${dropped.error}`,
    );
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // Serve captured vehicle photos out of R2.
    //
    // These live on the worker rather than the Pages app because Pages
    // bindings can only be added from the dashboard, and the worker already
    // has the bucket bound. Keys are opaque and only ever read, so this is
    // not an open proxy.
    if (url.pathname.startsWith("/img/")) {
      const key = decodeURIComponent(url.pathname.slice(5));
      if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

      const ifNoneMatch = req.headers.get("if-none-match");
      const object = await env.PHOTOS.get(key, {
        onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
      });
      if (!object) return new Response("Not found", { status: 404 });

      const headers = {
        "content-type": object.httpMetadata?.contentType || "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
        etag: object.httpEtag,
        "access-control-allow-origin": "*",
      };
      if (!("body" in object) || object.body === undefined) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(object.body as any, { headers });
    }

    // Dry-run the parser over emails already in raw_emails. Writes nothing;
    // exists so a parser change can be measured against real mail before it
    // goes anywhere near the listings table.
    //   /replay?token=…&id=397                 one email, full detail
    //   /replay?token=…&since=2026-07-01&limit=25   batch, aggregate stats
    if (url.pathname === "/replay" && url.searchParams.get("token") === env.TRIGGER_TOKEN) {
      const idParam = url.searchParams.get("id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50);
      try {
        // Every id costs an LLM call, so the explicit list is capped the same
        // way `limit` is — otherwise ?id=1,2,3,…,10000 is an expensive way to
        // burn the API key.
        const ids = idParam
          ? idParam.split(",").map(Number).filter((n) => Number.isFinite(n)).slice(0, 50)
          : undefined;
        const summary = await replayBatch(env.DB, env.ANTHROPIC_API_KEY, {
          ids,
          since: url.searchParams.get("since") ?? undefined,
          limit,
          verbose: url.searchParams.get("verbose") === "1" || !!idParam,
        });
        return Response.json(summary);
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }

    // Pull Tacoma inventory from Auto.dev rather than waiting to be emailed
    // about one. `dry=1` reports what it would write without writing.
    //   /sweep?token=…&dry=1
    if (url.pathname === "/sweep" && url.searchParams.get("token") === env.TRIGGER_TOKEN) {
      if (!env.AUTODEV_API_KEY) {
        return Response.json(
          { error: "AUTODEV_API_KEY not set — run: wrangler secret put AUTODEV_API_KEY" },
          { status: 503 },
        );
      }
      const criteria = criteriaFromEnv(env);
      const distance = Number(url.searchParams.get("distance"));
      if (Number.isFinite(distance) && distance > 0) criteria.distanceMiles = distance;
      try {
        const result = await sweepInventory(env.DB, env.PHOTOS, env.AUTODEV_API_KEY, criteria, {
          dryRun: url.searchParams.get("dry") === "1",
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/digest" && url.searchParams.get("token") === env.TRIGGER_TOKEN) {
      try {
        const result = await buildAndSendDigest(env.DB, env.FORWARD, env.DIGEST_FROM, env.BUYER_EMAIL);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || String(err) }, { status: 500 });
      }
    }
    return new Response("tacoma-tracker-email-ingest", { status: 200 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Sweep before the digest so the 7am email reports on inventory pulled
    // minutes earlier rather than on whatever happened to be emailed in.
    // Wrapped so a sweep failure can never cost the operator their digest.
    if (env.AUTODEV_API_KEY) {
      try {
        const result = await sweepInventory(
          env.DB,
          env.PHOTOS,
          env.AUTODEV_API_KEY,
          criteriaFromEnv(env),
          { dryRun: false },
        );
        console.log(
          `[cron] sweep: fetched=${result.fetched} upserted=${result.upserted} ` +
            `new=${result.isNew} photos=${result.photosStored} calls=${result.apiCalls} ` +
            `dropped=${JSON.stringify(result.dropped)}${result.truncated ? " TRUNCATED" : ""}`,
        );
      } catch (err) {
        console.error("[cron] sweep failed — continuing to digest", err);
      }
    } else {
      console.log("[cron] sweep skipped — AUTODEV_API_KEY not set");
    }

    console.log("[cron] daily digest run");
    try {
      const result = await buildAndSendDigest(
        env.DB,
        env.FORWARD,
        env.DIGEST_FROM,
        env.BUYER_EMAIL,
      );
      console.log(`[cron] digest sent=${result.sent} rows=${result.rowCount}`);
    } catch (err) {
      console.error("[cron] digest failed", err);
    }
  },
};
