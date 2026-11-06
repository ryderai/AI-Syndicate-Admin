/* LINKEDIN OUTREACH — short INTERNAL emails (to Julie, CJ, Ryder). 6 Nov 2026.
 *
 * Two jobs only:
 *  1. A login code typed on the client's private page is emailed to Julie at
 *     once. CJ, 4 Nov 2026 email: "when they submit their code, it will send
 *     via email to you immediately". The code also shows on the console.
 *  2. A sales-page sign-up tells the team (setting signup_notify).
 *
 * NEVER A CLIENT. Client emails stay drafts in linkedin_outbox for a person
 * to send (Ryder's rule). This file refuses any address outside the team
 * list it is handed, so it can't be pointed at a client by mistake.
 *
 * Resend's HTTP API, RESEND_API_KEY (already in the console's Vercel env).
 * Sender: LINKEDIN_ALERT_FROM, default noreply@contact.aisyndicate.com (the
 * address AI Syndicate's site already sends from). It never throws: a failed
 * alert is logged and returned, and the page the client is on still works. */

const FROM = () => process.env.LINKEDIN_ALERT_FROM || "AI Syndicate <noreply@contact.aisyndicate.com>";

export async function sendInternalEmail({ to, subject, text, allowed }, { fetchImpl = globalThis.fetch } = {}) {
  const key = process.env.RESEND_API_KEY;
  const list = (Array.isArray(to) ? to : [to]).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean);
  const ok = new Set((allowed || []).map((x) => String(x || "").trim().toLowerCase()));
  const recipients = list.filter((x) => ok.has(x));
  if (!recipients.length) return { sent: false, reason: "no_team_recipient" };
  if (!key) return { sent: false, reason: "no_resend_key" };
  try {
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM(), to: recipients, subject: String(subject).slice(0, 200), text: String(text).slice(0, 5000) }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("linkedin-notify: resend", r.status, body.slice(0, 200));
      return { sent: false, reason: `resend_${r.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("linkedin-notify:", err?.message);
    return { sent: false, reason: "network" };
  }
}

/** The code email to Julie. Short, so it reads on a phone lock screen. */
export function codeEmail({ company, code, loginEmail }) {
  return {
    subject: `LinkedIn code for ${company}: ${code}`,
    text: [`${company} just sent their LinkedIn code: ${code}`, "", loginEmail ? `Their LinkedIn login email: ${loginEmail}` : "", "It's also on the console (LinkedIn page, top). Codes expire fast, so use it now.", "", "— AI Syndicate console"].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
  };
}

/** The team alert for a sales-page sign-up. */
export function signupEmail({ name, company, email, phone, goal, consoleUrl }) {
  return {
    subject: `New LinkedIn Outreach sign-up: ${company}`,
    text: [`${name} (${company}) signed up on the LinkedIn Outreach page and went on to Stripe.`, "", `Email: ${email}`, phone ? `Phone: ${phone}` : "", goal ? `Goal: ${goal}` : "",
      "", "Payment shows on the console once Stripe confirms it. Then send them the onboarding form link from the Sales-page sign-ups card.", consoleUrl ? `Console: ${consoleUrl}` : "", "", "— AI Syndicate console"]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"),
  };
}
