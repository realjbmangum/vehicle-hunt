import type { D1Database, SendEmail } from "@cloudflare/workers-types";
import { EmailMessage } from "cloudflare:email";

function buildMimeMessage(args: {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = "----=_TacomaDigest_" + Math.random().toString(36).slice(2);
  const messageId =
    "<" + Date.now() + "." + Math.random().toString(36).slice(2) + "@" +
    args.from.split("@")[1] + ">";
  // Encode subject as UTF-8 to handle special chars (·, →, etc.)
  const encodedSubject =
    "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(args.subject))) + "?=";

  return (
    `From: ${args.fromName} <${args.from}>\r\n` +
    `To: ${args.to}\r\n` +
    `Subject: ${encodedSubject}\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    btoa(unescape(encodeURIComponent(args.text))).match(/.{1,76}/g)!.join("\r\n") +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    btoa(unescape(encodeURIComponent(args.html))).match(/.{1,76}/g)!.join("\r\n") +
    `\r\n` +
    `--${boundary}--\r\n`
  );
}

interface DigestRow {
  id: number;
  year: number;
  trim: string | null;
  price: number;
  mileage: number | null;
  dealer_name: string | null;
  dealer_location: string | null;
  listing_url: string | null;
  source: string | null;
  deal_score: number;
  deal_grade: string;
  vin: string | null;
  ingested_at: string | null;
  last_seen_at: string | null;
  price_history: string | null;
}

export async function buildAndSendDigest(
  db: D1Database,
  forwarder: SendEmail,
  fromAddr: string,
  toAddr: string,
): Promise<{ sent: boolean; rowCount: number }> {
  const rows = await db
    .prepare(
      `SELECT id, year, trim, price, mileage, dealer_name, dealer_location,
              listing_url, source, deal_score, deal_grade, vin,
              ingested_at, last_seen_at, price_history
       FROM listings
       WHERE alert_status = 'pending'
         AND deal_grade IN ('A', 'B')
         AND status = 'watching'
       ORDER BY deal_score DESC
       LIMIT 50`,
    )
    .all<DigestRow>();

  const listings = rows.results || [];
  if (listings.length === 0) {
    return { sent: false, rowCount: 0 };
  }

  const aGrade = listings.filter((r) => r.deal_grade === "A");
  const bGrade = listings.filter((r) => r.deal_grade === "B");

  const subject = `[Tacomas] ${aGrade.length} Grade A · ${bGrade.length} Grade B today`;
  const html = renderHtml(aGrade, bGrade);
  const text = renderText(aGrade, bGrade);

  const raw = buildMimeMessage({
    from: fromAddr,
    fromName: "Tacoma Tracker",
    to: toAddr,
    subject,
    text,
    html,
  });

  const message = new EmailMessage(fromAddr, toAddr, raw);
  await forwarder.send(message);

  const ids = listings.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(`UPDATE listings SET alert_status = 'digested' WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();

  return { sent: true, rowCount: listings.length };
}

function escHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function fmtPrice(p: number) {
  return "$" + p.toLocaleString();
}

function fmtMiles(m: number | null) {
  return m == null ? "?mi" : m.toLocaleString() + " mi";
}

function priceDropNote(history: string | null): string {
  if (!history) return "";
  try {
    const arr = JSON.parse(history) as Array<{ price: number; at: string }>;
    if (arr.length < 2) return "";
    const first = arr[0].price;
    const last = arr[arr.length - 1].price;
    if (last < first) {
      return ` <span style="color:#22c55e">↓ $${(first - last).toLocaleString()}</span>`;
    }
  } catch {}
  return "";
}

function rowHtml(r: DigestRow): string {
  const safeSrc = escHtml(r.source);
  const sourceLabel = r.source ? `<span style="color:#888;font-size:12px"> · ${safeSrc}</span>` : "";
  const trim = r.trim ? ` ${escHtml(r.trim)}` : "";
  const dealer = r.dealer_name
    ? `<div style="color:#888;font-size:12px">${escHtml(r.dealer_name)}${r.dealer_location ? " · " + escHtml(r.dealer_location) : ""}</div>`
    : "";
  const url = safeUrl(r.listing_url);
  const link = url
    ? `<a href="${escHtml(url)}" style="color:#3b82f6">View listing →</a>`
    : "";
  return `
    <tr style="border-bottom:1px solid #2a2a2a">
      <td style="padding:12px 8px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#1f3b1f;color:#22c55e;font-weight:bold;font-size:14px">${escHtml(r.deal_grade)} · ${r.deal_score}</span>
          <strong style="color:#fff">${r.year} Tacoma${trim}</strong>${sourceLabel}
        </div>
        <div style="margin-top:6px;color:#ccc;font-size:14px">
          <strong>${fmtPrice(r.price)}</strong>${priceDropNote(r.price_history)} · ${fmtMiles(r.mileage)}
        </div>
        ${dealer}
        <div style="margin-top:6px">${link}</div>
      </td>
    </tr>`;
}

function renderHtml(aGrade: DigestRow[], bGrade: DigestRow[]): string {
  const dashboardUrl = "https://tacoma-tracker.pages.dev";
  const aRows = aGrade.map(rowHtml).join("");
  const bRows = bGrade.map(rowHtml).join("");

  return `<!doctype html>
<html><body style="background:#0f0f0f;color:#eee;font-family:-apple-system,sans-serif;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto">
    <h1 style="color:#fff;font-size:22px;margin-bottom:4px">Tacoma Tracker · Daily Digest</h1>
    <div style="color:#888;font-size:13px;margin-bottom:24px">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</div>

    ${aGrade.length > 0 ? `
    <h2 style="color:#22c55e;font-size:16px;margin:0 0 8px">Grade A · Act on these (${aGrade.length})</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;background:#1a1a1a;border-radius:8px;overflow:hidden">${aRows}</table>` : ""}

    ${bGrade.length > 0 ? `
    <h2 style="color:#84cc16;font-size:16px;margin:0 0 8px">Grade B · Worth a look (${bGrade.length})</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;background:#1a1a1a;border-radius:8px;overflow:hidden">${bRows}</table>` : ""}

    <div style="margin-top:32px;padding:16px;background:#1a1a1a;border-radius:8px;color:#888;font-size:13px">
      <a href="${dashboardUrl}" style="color:#3b82f6">Open the dashboard →</a>
    </div>
  </div>
</body></html>`;
}

function renderText(aGrade: DigestRow[], bGrade: DigestRow[]): string {
  const fmt = (r: DigestRow) =>
    `[${r.deal_grade} · ${r.deal_score}] ${r.year} Tacoma${r.trim ? " " + r.trim : ""} — ${fmtPrice(r.price)} · ${fmtMiles(r.mileage)}\n  ${r.dealer_name || r.source || ""}\n  ${r.listing_url || ""}`;

  let out = `Tacoma Tracker — ${new Date().toLocaleDateString()}\n\n`;
  if (aGrade.length) {
    out += `Grade A (${aGrade.length})\n${"-".repeat(40)}\n`;
    out += aGrade.map(fmt).join("\n\n") + "\n\n";
  }
  if (bGrade.length) {
    out += `Grade B (${bGrade.length})\n${"-".repeat(40)}\n`;
    out += bGrade.map(fmt).join("\n\n") + "\n\n";
  }
  out += `\nDashboard: https://tacoma-tracker.pages.dev\n`;
  return out;
}
