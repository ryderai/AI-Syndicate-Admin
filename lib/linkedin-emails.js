/* LINKEDIN OUTREACH — the emails the flow drafts. 4 Nov 2026.
 *
 * CJ's brief, Build 4: "Four templates ... resources ready for review,
 * revised version ready, approved + book your slot, outreach is live (with
 * the instruction to watch the Sales Navigator inbox)". Plus the lead alert
 * (Build 2) and the PIN instructions (CJ's phone call, 4 Nov 2026).
 *
 * THESE ARE DRAFTS. They go into linkedin_outbox; a person copies one into
 * Gmail and marks it sent. Nothing here sends anything (Ryder's rule: nothing
 * reaches a client without a person's yes). Wording is ours — the brief's
 * "Resources workbook" wasn't available. Pure. */

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const sign = ["", "Thanks,", "The AI Syndicate team"];

export function draftEmail(kind, d = {}) {
  const hi = `Hi ${first(d.contactName)},`;
  switch (kind) {
    case "resources_ready":
      return { subject: `Your LinkedIn outreach is ready for review — ${d.company}`, text: [hi, "", "Your LinkedIn messages and target lists are ready. There are two versions of the messages; pick the one you like, or tell us what to change.", "", `Review here (no login needed): ${d.approvalUrl}`, ...sign].join("\n") };
    case "revision_coming":
      return { subject: `Got it — revising your LinkedIn outreach (${d.company})`, text: [hi, "", "Thanks for the notes. We're revising the messages now and will send the new version for review shortly.", ...sign].join("\n") };
    case "revised_ready":
      return { subject: `Revised version ready — ${d.company}`, text: [hi, "", "The revised version is ready for review.", "", `Review here: ${d.approvalUrl}`, ...sign].join("\n") };
    case "approved_book":
      return {
        subject: `Approved — book your 5-minute login (${d.company})`,
        text: [hi, "", "Thanks for approving. The last step is a 5-minute login so Julie can start your outreach.", "",
          d.bookingUrl ? `1. Book a time here: ${d.bookingUrl}` : "1. Reply with a time that works for a 5-minute login.",
          "2. At that time, have your LinkedIn password ready and be near the email inbox (or phone) where LinkedIn sends you codes.",
          `3. When LinkedIn sends you a verification code, type it here: ${d.pinUrl}`,
          "   Julie sees it instantly and finishes the login. You don't need to call or email anyone.", ...sign].join("\n"),
      };
    case "live":
      return { subject: `Your LinkedIn outreach is live — ${d.company}`, text: [hi, "", "Your outreach is live. Julie is sending each business day.", "", "Most replies land in your Sales Navigator inbox, so please check it daily. When someone is interested, we'll also email you their message with a suggested reply.", ...sign].join("\n") };
    case "lead_alert":
      return {
        subject: `New lead on LinkedIn: ${d.prospect || "a prospect"} (${d.classification})`,
        text: [hi, "", `${d.prospect || "A prospect"} replied on LinkedIn (${d.inbox || "inbox not noted"}):`, "", `"${d.message}"`,
          d.referredName ? `\nThey referred you to: ${d.referredName}` : "",
          "", d.suggested ? "A suggested reply you can send:" : "", d.suggested ? "" : "", d.suggested || "",
          d.threadUrl ? `\nTheir profile: ${d.threadUrl}` : "", ...sign].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
      };
    default:
      return null;
  }
}
