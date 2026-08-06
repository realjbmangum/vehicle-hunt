import type { APIRoute } from "astro";

/**
 * Serve a captured vehicle photo out of R2.
 *
 * Photos are stored under `listings/<id>/<hash>.<ext>` and referenced from
 * D1 as `/img/listings/<id>/<hash>.<ext>`, so the app never depends on a
 * dealer CDN that will 404 the moment the truck sells.
 */
export const GET: APIRoute = async ({ params, locals, request }) => {
  const key = params.key;
  if (!key || key.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  const bucket = (locals as any).runtime?.env?.PHOTOS;
  if (!bucket) {
    return new Response("Photo storage unavailable", { status: 503 });
  }

  // Serve 304s so a revisit doesn't re-download every truck photo.
  const etagHeader = request.headers.get("if-none-match");
  const object = await bucket.get(key, {
    onlyIf: etagHeader ? { etagDoesNotMatch: etagHeader } : undefined,
  });

  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  if (!("body" in object) || object.body === undefined) {
    // onlyIf matched — client's copy is current.
    return new Response(null, { status: 304, headers: { etag: object.httpEtag } });
  }

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType || "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
  });
};
