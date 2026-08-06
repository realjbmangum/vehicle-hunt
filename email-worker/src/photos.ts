// Photo capture into R2.
//
// Dealer CDN URLs rot: when a listing is delisted the image 404s, and the
// truck you were tracking becomes a grey box. So we don't store the dealer's
// URL — we fetch the bytes once, put them in R2, and store our own key.
//
// The app serves these back through /img/<key>, so nothing depends on the
// dealer's CDN staying up or on their hotlink policy.

import type { R2Bucket } from "@cloudflare/workers-types";
import { HUNT } from "../../hunt.config.ts";

const MAX_BYTES = 6 * 1024 * 1024; // a listing photo over 6 MB is not a photo
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];

export interface StoredPhoto {
  key: string;
  /** Absolute URL the app renders. */
  path: string;
  bytes: number;
  contentType: string;
}

function extensionFor(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("avif")) return "avif";
  return "jpg";
}

/** Stable key from the source URL so the same photo never stores twice. */
async function keyFor(listingId: number, sourceUrl: string, ext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sourceUrl));
  const hash = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `listings/${listingId}/${hash}.${ext}`;
}

/**
 * Fetch a photo and put it in R2. Returns null on any problem — a missing
 * photo must never cost us the listing itself.
 */
const PHOTO_BASE = HUNT.notify.photoBaseUrl;

export async function capturePhoto(
  bucket: R2Bucket,
  listingId: number,
  sourceUrl: string,
): Promise<StoredPhoto | null> {
  if (!/^https?:\/\//i.test(sourceUrl)) return null;

  try {
    const res = await fetch(sourceUrl, {
      headers: {
        // Some dealer CDNs 403 a bare fetch with no UA or referer.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "image/avif,image/webp,image/jpeg,image/png,*/*",
      },
    });
    if (!res.ok) {
      console.log(`[photo] ${res.status} fetching ${sourceUrl.slice(0, 80)}`);
      return null;
    }

    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(contentType)) {
      console.log(`[photo] rejected content-type ${contentType || "(none)"}`);
      return null;
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
      console.log(`[photo] rejected size ${buf.byteLength}`);
      return null;
    }
    // A 1x1 tracking pixel that slipped past the URL heuristics.
    if (buf.byteLength < 2048) {
      console.log(`[photo] rejected tiny image (${buf.byteLength} bytes)`);
      return null;
    }

    const key = await keyFor(listingId, sourceUrl, extensionFor(contentType));
    await bucket.put(key, buf, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { sourceUrl: sourceUrl.slice(0, 500), listingId: String(listingId) },
    });

    console.log(`[photo] stored ${key} (${Math.round(buf.byteLength / 1024)}kb)`);
    return { key, path: `${PHOTO_BASE}/${key}`, bytes: buf.byteLength, contentType };
  } catch (err) {
    console.error("[photo] capture failed", err);
    return null;
  }
}
