/* START PACKETS — the questions and labels. PURE and browser-safe (no node
 * imports), so the console page and the server read the SAME list.
 * lib/start-packet.js re-exports everything here. 6 Nov 2026. */

/* ------------------------------------------------------------------ */
/* The questions                                                       */
/* ------------------------------------------------------------------ */
/* Copied from the universal GEO onboarding form (geo-onboarding-woad.vercel.app,
 * built 4 Nov 2026) so we get the same answers we get today. "website" = the
 * extra new-website questions from the IFS form, made general. House rule: no
 * passwords asked, ever; Google Business Profile = a link only. */

const ACCESS4 = ["Invite sent", "Will do", "Don't have one", "Not sure"];
export const GRANT_EMAIL = "growth@aisyndicate.com";

export const PLATFORM_STEPS = {
  WordPress: [
    "Sign in to your site's dashboard (usually yoursite.com/wp-admin).",
    "Go to Users → Add New User.",
    `Username: aisyndicate. Email: ${GRANT_EMAIL}.`,
    "Role: Administrator. We need it to add the files AI tools read.",
    "Click Add New User. WordPress emails us a link to set our own password.",
  ],
  Webflow: [
    "Open webflow.com/dashboard and sign in.",
    "Go to Team → Users → Agency or Freelancer Guests.",
    `Click Invite guest and enter ${GRANT_EMAIL}.`,
    "Leave Allowed roles as they are and turn on Can publish.",
    "Click Invite.",
  ],
  Shopify: [
    "Put your store address (it ends in .myshopify.com) in the notes at the end.",
    "We send a collaborator request from our side. It doesn't use a staff seat.",
    "When it arrives, go to Settings → Users and click Accept on our request.",
  ],
  Squarespace: [
    "Open your site and go to Settings → Permissions & Ownership.",
    `Click Invite contributor and enter ${GRANT_EMAIL}.`,
    "Permission: Administrator.",
    "Click Invite.",
  ],
  Wix: [
    "Open your site's dashboard and go to Settings → Roles & Permissions.",
    `Click Invite People and enter ${GRANT_EMAIL}.`,
    "Role: Admin.",
    "Click Send Invite.",
  ],
  "A company runs it for us": [
    "Many website companies don't let you add users.",
    "Put that company's name and your contact there under \"Who runs the website day to day?\".",
    "We'll reach out to them, or send you the exact changes to ask for.",
  ],
  "Custom code": [
    "Ask your developer to add us to the code (GitHub, GitLab, or Bitbucket), or we can send them each change.",
    "Put their name and email under \"Who runs the website day to day?\".",
  ],
  "Not sure": [
    "No problem. Put your web person under \"Who runs the website day to day?\".",
    "We'll find out what the site runs on and send you the exact steps.",
  ],
};

export const PARTS = [
  { id: "people", title: "Who we'll work with" },
  { id: "facts", title: "The facts AI should know" },
  { id: "newsite", title: "Your new website", only: "website_geo" },
  { id: "access", title: "Access to your site" },
  { id: "boosts", title: "Optional boosts" },
  { id: "win", title: "What a win looks like" },
];

export const QUESTIONS = [
  { id: "c_name", part: "people", label: "Your name", type: "text", required: true, prefill: "contact_name" },
  { id: "c_role", part: "people", label: "Your role", type: "text" },
  { id: "c_email", part: "people", label: "Email", type: "email", required: true, prefill: "contact_email" },
  { id: "c_phone", part: "people", label: "Phone", type: "tel" },
  { id: "c_approver", part: "people", label: "Who approves what we publish?", hint: "Name and email. They see our wording before it goes live.", type: "textarea" },
  { id: "c_web", part: "people", label: "Who runs the website day to day?", hint: "Name, company, and email of your web person or agency. If that's you, just say \"me.\"", type: "textarea" },
  { id: "c_report", part: "people", label: "Who should get the monthly report?", hint: "Names and emails.", type: "text" },
  { id: "c_others", part: "people", label: "Anyone else to keep in the loop?", type: "textarea" },

  { id: "b_name", part: "facts", label: "Business name", hint: "The name customers know you by.", type: "text", required: true, prefill: "business" },
  { id: "b_legal", part: "facts", label: "Legal company name", hint: "Only if it's different from the name above.", type: "text" },
  { id: "b_address", part: "facts", label: "Business address and main phone", hint: "The one you want shown everywhere online. Several locations? List each with its phone. If you don't show your address publicly, say so.", type: "textarea" },
  { id: "b_offer", part: "facts", label: "What do you offer?", hint: "Your main services or products, most important first.", type: "textarea", required: true },
  { id: "b_customers", part: "facts", label: "Who are your best customers or clients?", hint: "For example: homeowners, small businesses, families, retirees.", type: "text" },
  { id: "b_area", part: "facts", label: "Where do you serve customers?", type: "radio", options: ["One city or town", "A few cities or a region", "Statewide", "Nationwide", "International"] },
  { id: "b_cities", part: "facts", label: "Cities or areas you want to be known for", type: "text" },
  { id: "b_searches", part: "facts", label: "What questions should AI answer with your name?", hint: "The way a customer would ask it. One per line is perfect.", type: "textarea" },
  { id: "b_competitors", part: "facts", label: "Main competitors", hint: "Names or websites. We measure you against them.", type: "textarea" },
  { id: "b_proof", part: "facts", label: "Proof we can point to", hint: "Reviews, awards, press, licenses, years in business. Links are perfect. We only use facts you already publish or approve.", type: "textarea" },
  { id: "b_avoid", part: "facts", label: "Anything we should never say?", hint: "Claims, words, or topics to stay away from.", type: "textarea" },
  { id: "b_rules", part: "facts", label: "Any industry rules we must follow?", hint: "For example: state bar advertising rules, medical privacy (HIPAA) limits on tracking, insurance or financial disclosures. \"None\" is a fine answer.", type: "textarea" },
  { id: "b_social", part: "facts", label: "Social profiles and listings", hint: "Facebook, Instagram, LinkedIn, YouTube, Yelp, and any directory listings. One link per line.", type: "textarea" },

  { id: "n_goals", part: "newsite", label: "What should the new site do best?", hint: "Pick any.", type: "checks", options: ["Bring in more calls and leads", "Look more established", "Show up in AI search and Google", "Take bookings or sell online", "Recruit staff or partners"] },
  { id: "n_pages", part: "newsite", label: "Pages you want on the new site", hint: "Keep, add, or drop. A rough list is fine.", type: "textarea" },
  { id: "n_features", part: "newsite", label: "Must-keep features", hint: "Forms, booking, menus, logins, calculators — anything people use now.", type: "textarea" },
  { id: "n_likes", part: "newsite", label: "2 or 3 websites you like the look of", type: "textarea" },
  { id: "n_brand", part: "newsite", label: "Your brand look", type: "radio", options: ["Keep our colors and logo", "Keep the logo, refresh the rest", "Open to a full refresh"] },
  { id: "n_logo", part: "newsite", label: "Logo files (link)", hint: "A Google Drive or Dropbox link is perfect.", type: "url" },
  { id: "n_photos", part: "newsite", label: "Photos and video (link)", type: "url" },
  { id: "n_team", part: "newsite", label: "Team bios and headshots", hint: "A link, or say \"use what's on the site now.\"", type: "textarea" },
  { id: "n_testimonials", part: "newsite", label: "Customer reviews or testimonials we can use", type: "textarea" },
  { id: "n_words", part: "newsite", label: "Who writes the words on the new site?", type: "radio", options: ["You draft, we approve", "We'll supply the text", "A mix"] },
  { id: "n_urls", part: "newsite", label: "Old links that must keep working", hint: "Pages printed on cards, ads, or shared a lot.", type: "textarea" },

  { id: "w_url", part: "access", label: "Website address", type: "url", required: true, prefill: "website" },
  { id: "w_platform", part: "access", label: "What is the site built on?", type: "radio", options: Object.keys(PLATFORM_STEPS), steps: true },
  { id: "w_status", part: "access", label: "Where is the invite?", type: "radio", options: ["Invite sent", "I'll send it this week", "Our web person will send it", "I need help"] },
  { id: "w_domain", part: "access", label: "Where is the domain registered?", hint: "GoDaddy, Namecheap, Google/Squarespace, Cloudflare… \"Not sure\" is fine.", type: "text" },
  { id: "w_cdn", part: "access", label: "Firewall in front of the site?", type: "radio", options: ["Cloudflare", "Other", "None", "Not sure"] },
  { id: "w_dns", part: "access", label: "Who can change your domain settings?", hint: "Domain settings (DNS) connect your web address to your site and email. We may need one small change to prove to Google and Bing that the site is yours.", type: "text" },

  { id: "a_gsc", part: "boosts", label: "Google Search Console", type: "radio", options: ACCESS4 },
  { id: "a_ga4", part: "boosts", label: "Google Analytics 4", type: "radio", options: ACCESS4 },
  { id: "a_bing", part: "boosts", label: "Bing Webmaster Tools", type: "radio", options: ACCESS4 },
  { id: "a_gtm", part: "boosts", label: "Google Tag Manager", type: "radio", options: ACCESS4 },
  { id: "a_gbp", part: "boosts", label: "Google Business Profile", type: "radio", options: ["Have one (link below)", "Don't have one", "Not sure"] },
  { id: "a_gbp_link", part: "boosts", label: "Google Business Profile link", hint: "Just the link. You don't need to add us to it.", type: "url" },
  { id: "a_other", part: "boosts", label: "Other tools already running?", hint: "Call tracking, CRM, review platforms, Meta Pixel, dashboards. Names are enough.", type: "textarea" },

  { id: "g_win", part: "win", label: "What would make the first 90 days a win?", type: "textarea" },
  { id: "g_dates", part: "win", label: "Busy seasons, launches, or deadlines coming up?", type: "textarea" },
  { id: "g_leads", part: "win", label: "Where do website leads go today?", hint: "A CRM, a shared inbox, or a person. Helps us count the leads AI search brings in.", type: "text" },
  { id: "g_notes", part: "win", label: "Anything else we should know?", type: "textarea" },
];

export const FORM_KINDS = { geo: "GEO only", website_geo: "Website + GEO" };

export function questionsFor(kind) {
  const parts = PARTS.filter((p) => !p.only || p.only === kind).map((p) => p.id);
  return QUESTIONS.filter((q) => parts.includes(q.part));
}
export function partsFor(kind) { return PARTS.filter((p) => !p.only || p.only === kind); }


/** Where a packet is, in words, for the console list. */
export function stageLabel(packet) {
  switch (packet?.status) {
    case "draft": return "Draft — waiting for CJ to sign";
    case "ready": return "Signed by CJ — ready to send";
    case "sent": return "Sent — not opened yet";
    case "opened": return "Opened by the client";
    case "returned": return "Signed + sent back";
    case "void": return "Cancelled";
    default: return String(packet?.status || "");
  }
}

