/* START PACKETS — INTERNAL emails only (the team copy, "ready for CJ").
 * 6 Nov 2026.
 *
 * NEVER A CLIENT. The client email is sent by a person from their own Gmail
 * (the console's /api/gmail-send) or copied and pasted. This file refuses any
 * address that is not on the team list it is handed.
 *
 * Resend's HTTP API with RESEND_API_KEY (already in the console's Vercel env;
 * the LinkedIn team emails were seen arriving from it on 6 Nov). Sender:
 * START_PACKET_FROM, default noreply@contact.aisyndicate.com. It never throws:
 * a failed email is returned, and the client's page still says "sent". */

const FROM = () => process.env.START_PACKET_FROM || "AI Syndicate <noreply@contact.aisyndicate.com>";

export async function sendTeamEmail({ to, subject, text, replyTo, allowed }, { fetchImpl = globalThis.fetch } = {}) {
  const key = process.env.RESEND_API_KEY;
  const ok = new Set((allowed || []).map((x) => String(x || "").trim().toLowerCase()));
  const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x || "").trim().toLowerCase()).filter((x) => x && ok.has(x));
  if (!recipients.length) return { sent: false, reason: "no_team_recipient", to: [] };
  if (!key) return { sent: false, reason: "no_resend_key", to: recipients };
  try {
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM(), to: recipients, subject: String(subject).slice(0, 200), text: String(text).slice(0, 20000),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("start-notify: resend", r.status, body.slice(0, 200));
      return { sent: false, reason: `resend_${r.status}`, to: recipients };
    }
    return { sent: true, to: recipients };
  } catch (err) {
    console.error("start-notify:", err?.message);
    return { sent: false, reason: "network", to: recipients };
  }
}
