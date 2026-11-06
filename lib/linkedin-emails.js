/* LINKEDIN OUTREACH — the emails the flow drafts. 4 Nov 2026.
 *
 * CJ's brief, Build 4: "Four templates ... resources ready for review,
 * revised version ready, approved + book your slot, outreach is live (with
 * the instruction to watch the Sales Navigator inbox)". Plus the lead alert
 * (Build 2) and the PIN instructions (CJ's phone call, 4 Nov 2026).
 *
 * THESE ARE DRAFTS. They go into linkedin_outbox; a person copies one into
 * Gmail and marks it sent. Nothing here sends anything (Ryder's rule: nothing
 * reaches a client without a person's yes). Pure. */

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const sign = (closing = "Talk more soon,") => ["", closing, "The AI Syndicate team"];

/* Julie's inbox for forwarded LinkedIn codes. CJ, 4 Nov 2026 (email, 3:13 PM
 * CT): "clients forward the LinkedIn code email during the 5-minute login.
 * Julie's primary email is porcallajulieann01@gmail.com". He asked Julie to
 * confirm, so it is a setting (julie_email) with this as the fallback. */
export const DEFAULT_JULIE_EMAIL = "porcallajulieann01@gmail.com";

/* WORDING (4 Nov 2026): taken from CJ's "LinkedIn Outreach Resources.xlsx",
 * sheet "Message", which arrived with his 3:13 PM email. Same order and voice;
 * the Google Drive folder becomes the private review page, and "I" becomes
 * "we" because the team, not one person, signs these. */
export function draftEmail(kind, d = {}) {
  const hi = `Hello ${first(d.contactName)},`;
  switch (kind) {
    case "onboarding_received":
      return { subject: `Onboarding received — ${d.company}`, text: [`Hello ${first(d.contactName)}! Onboarding has been received, thanks for getting that taken care of.`, "",
        `We'll have all campaign resources shared with you for review${d.dueBy ? ` by ${d.dueBy}` : " shortly"}. From there, we'll make any needed adjustments based on your feedback and then we'll be ready for launch!`,
        /* CJ, 4 Nov 2026: "The onboarding confirmation email should include" Julie's booking link. */
        ...(d.bookingUrl ? ["", `Once you approve, you'll pick a time for a quick 5-minute login here: ${d.bookingUrl}`] : []), ...sign()].join("\n") };
    case "resources_ready":
      return { subject: `Your LinkedIn campaign resources are ready for review — ${d.company}`, text: [hi, "", "Hope all is well! Just wanted to touch base and share the resources we've developed for your campaign: your target lists and two versions of your messaging.", "",
        `You can review everything here (no login needed): ${d.approvalUrl}`, "",
        "Please note, these resources are not final. Rather, they're a starting point for us to build on. Take as much time as you need to go through everything and pick the version you like, or tell us what to change.", "",
        "Once we get your feedback, we'll get any needed adjustments made, and then we'll be ready to access your profile and launch outreach!", ...sign("Looking forward to hearing your thoughts,")].join("\n") };
    case "revision_coming":
      return { subject: `Got it — refining your LinkedIn messaging (${d.company})`, text: [hi, "", "Thanks for the feedback. We're putting together a refined version of your messaging now and will share it for review shortly.", ...sign()].join("\n") };
    case "revised_ready":
      return { subject: `Refined messaging ready — ${d.company}`, text: [`Hello ${first(d.contactName)}! Hope you're having a great day.`, "", "Touching base, as we've put together a refined version of your messaging based on the feedback you provided.", "",
        `You can dive into it here: ${d.approvalUrl}`, "", "Let us know your thoughts once you have a chance to review!", ...sign()].join("\n") };
    case "approved_book": {
      /* v2, 6 Nov 2026. Julie (email 5 Nov): she can't make a separate
       * 5-minute booking link without a paid Google Calendar plan; WhatsApp
       * works best for the code; she needs the login email, the password and
       * the location for her VPN before she logs in. So the client fills in
       * a short private page (the same link as the code page), shares the
       * password through the tool in settings, and picks how to pass the
       * code. A booking link is still used when one is set. */
      const julie = d.julieEmail || DEFAULT_JULIE_EMAIL;
      const login = d.loginUrl || d.pinUrl;
      return {
        subject: `Approved — one quick step before launch (${d.company})`,
        text: [hi, "", "Thanks for approving! The last step is a quick 5-minute login so Julie, who runs your outreach, can launch your campaign. There's no call to join.", "",
          login ? `1. Fill in this private page (2 minutes): ${login}` : "1. Reply with the email you use for LinkedIn and the city you usually log in from.",
          "   It asks for the email you use for LinkedIn, the city you log in from, a couple of times that work, and how you'd like to pass Julie the code.",
          `2. Your password: ${d.passwordMethod || "Julie will send you a secure link to share it. Please don't email or text your password."}`,
          d.bookingUrl ? `3. Pick a time here: ${d.bookingUrl}` : "3. Julie confirms a time with you.",
          `4. At that time, Julie signs in and LinkedIn sends you a code. Pass it to her the way you chose: WhatsApp${d.julieWhatsapp ? ` (${d.julieWhatsapp})` : ""}, the same private page, or by forwarding the code email to ${julie}.`,
          ...sign()].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
      };
    }
    case "signup_paid":
      /* A sales-page sign-up paid (6 Nov 2026). CJ, text 5 Nov: "I'll reach
       * out and get them started" — so this is a DRAFT for him: thanks plus
       * the onboarding form, which is what starts the 48-hour copy clock. */
      return { subject: `Welcome to LinkedIn Outreach — next step (${d.company})`, text: [hi, "", "Thanks for signing up for LinkedIn Outreach! Your first month is confirmed.", "",
        `The next step is a short onboarding form about your business, who you want to reach and how you like to sound: ${d.formUrl}`, "",
        "Once it's in, we'll have your messages and target lists ready for you to review within 48 hours. Nothing goes out until you approve it.", ...sign()].join("\n") };
    case "live":
      return { subject: `Your LinkedIn outreach is live — ${d.company}`, text: [hi, "", "Your outreach is live!", "",
        "One thing to call out as we get going: in addition to monitoring the main inbox on LinkedIn, be sure to keep an eye on your Sales Navigator inbox also, as the majority of outreach will be occurring there. You can find it by opening the Sales Nav dashboard and then clicking \u201cmessaging\u201d.", "",
        "Let us know if you have any questions there.", ...sign("Talk soon,")].join("\n") };
    case "lead_alert":
      return {
        subject: `New lead on LinkedIn: ${d.prospect || "a prospect"} (${d.classification})`,
        text: [hi, "", `${d.prospect || "A prospect"} replied on LinkedIn (${d.inbox || "inbox not noted"}):`, "", `"${d.message}"`,
          d.referredName ? `\nThey referred you to: ${d.referredName}` : "",
          "", d.suggested ? "A suggested reply you can send:" : "", d.suggested ? "" : "", d.suggested || "",
          d.threadUrl ? `\nTheir profile: ${d.threadUrl}` : "", ...sign()].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
      };
    default:
      return null;
  }
}
