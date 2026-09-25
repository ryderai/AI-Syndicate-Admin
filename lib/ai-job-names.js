/* PLAIN-ENGLISH NAMES FOR EVERY AI JOB AND SERVICE — 25 Sep 2026.
 *
 * Ryder: "i just want the overall page to be simpler to read the titles for
 * things so we know exactly what it is. i dont want to read code, i want to
 * read english."
 *
 * The usage log stores what the platform calls a job — `pagefix.generate`,
 * `simulator.run`, `/api/lead/`. This file turns each one into a name a
 * person can read and one sentence on what it does. The raw key is still
 * shown small beside it, so anyone matching the page to the code can.
 *
 * Where the names came from: the platform's own cost table
 * (ai-syndicate-live lib/plan-tokens.js, which carries a label per job) and
 * its handler names (lib/ai-meter-features.js), rewritten so a non-developer
 * knows what the work is. A job that is not in this list still gets a
 * readable name: its key is turned into words, and it is marked so we know
 * to add it here.
 */

export const JOBS = {
  // --- AI Access (the website audit and its fixes) ---
  "pagefix.generate": { name: "Write fixes for website pages", what: "AI Access writes ready-to-paste fixes for each page of a site, then checks its own answer. Runs for every audited page when someone clicks \"Generate gold-standard fixes\", and automatically for the worst pages after an audit." },
  "pageFixes.page": { name: "Write fixes for website pages", what: "Credits charged per page that got fresh fixes written." },
  "audit.domain": { name: "Website audit (AI Access)", what: "Reads a website's pages the way AI search engines do and scores what they can and can't understand." },
  "AI Access: domain audit": { name: "Website audit (AI Access)", what: "Reads a website's pages the way AI search engines do and scores what they can and can't understand." },
  "audit.run": { name: "Website audit (AI Access)", what: "One audit run of a website." },
  "audit.claudeFetch": { name: "Live check: can Claude read the site", what: "Asks Claude to fetch the site live, to prove what it can see." },
  "AI Access: identity check": { name: "Write the business summary for the audit report", what: "Writes the summary, contact details and schema section of the AI Access report." },
  "generator.artifact": { name: "Generate site files (llms.txt, schema, FAQs)", what: "Writes the AI-readable files and code blocks a site needs." },

  // --- Is the business named by AI? ---
  "simulator.run": { name: "AI visibility test", what: "Asks ChatGPT, Gemini, Perplexity and the others the customer's questions and records who gets recommended." },
  "simulator.suggest": { name: "Suggest questions to test", what: "Suggests the questions a customer should track." },
  "simulator.retry": { name: "Re-ask an AI engine that failed", what: "Retries one engine inside a visibility test." },
  "tracker.probe": { name: "Daily tracked-question check", what: "Re-asks each tracked question on a schedule to see if the answer changed." },
  "tracker.visitors": { name: "AI-visitor tracking", what: "Works out which AI tools sent visitors to the site." },
  "tracker.translate": { name: "Translate an AI answer", what: "Translates a non-English AI answer so it can be read." },
  "brand.probe": { name: "Brand check: what AI says about the business", what: "Asks the AI engines about the brand and records what they say." },
  "brand.scan": { name: "Brand scan", what: "Full scan of how the brand shows up in AI answers." },
  "competitors.discover": { name: "Find competitors", what: "Finds the businesses AI recommends instead of the customer." },
  "multimarket.market": { name: "Scan another city or market", what: "Runs the visibility test in another location." },
  "multimarket.suggest": { name: "Suggest questions for another market", what: "Suggests questions to track in a new location." },

  // --- Is what AI says correct? ---
  "accuracy.run": { name: "Accuracy check: is AI telling the truth about the business", what: "Asks AI engines factual questions about the business and checks the answers against the facts." },
  "accuracy.scan": { name: "Read the business's facts from its website", what: "Collects the facts (hours, services, address) to check AI answers against." },
  "accuracy.correct": { name: "Write a correction for a wrong AI answer", what: "Drafts what to publish so AI stops repeating a wrong fact." },
  "accuracy.reprobe": { name: "Re-check one AI answer", what: "Asks one question again to see if a fix worked." },

  // --- Reviews and reputation ---
  "sentiment.scan": { name: "Review sentiment scan", what: "Reads the business's reviews and sums up what people like and dislike." },
  "sentiment.refresh": { name: "Review sentiment refresh", what: "Updates the review summary with new reviews." },
  "reviews.sources": { name: "Pull reviews from review sites", what: "Collects reviews from the sites where the business is listed." },
  "review.reply": { name: "Draft a review reply", what: "Writes a reply to a customer review." },
  "review.request": { name: "Send a review request", what: "Asks a customer to leave a review." },
  "authority.offsite": { name: "Check mentions on other websites", what: "Looks for the business on other sites AI trusts." },
  "local.signals": { name: "Local listing check", what: "Checks the business's local listings and signals." },
  "Local signals": { name: "Local listing check", what: "Checks the business's local listings and signals." },

  // --- Content, social, press ---
  "content.brief": { name: "Write a content brief", what: "Plans one article." },
  "content.draft": { name: "Write a long article", what: "Writes a full draft article." },
  "content.planMonth": { name: "Plan a month of content", what: "Plans a month of articles." },
  "content.rewrite": { name: "Rewrite a section", what: "Rewrites part of an article." },
  "social.post": { name: "Write a social post", what: "Drafts one social media post." },
  "social.image": { name: "Make a social image", what: "Generates an image for a post." },
  "social.video": { name: "Make a social video", what: "Generates a video for a post." },
  "social.planCampaign": { name: "Plan a social campaign", what: "Plans a set of posts." },
  "social.planMonth": { name: "Plan a month of social posts", what: "Plans a month of posts." },
  "social.alerts": { name: "Social alerts (scheduled)", what: "Checks social accounts for things worth a reply." },
  "social.digest": { name: "Social summary email (scheduled)", what: "Writes the regular social summary." },
  "social.publish": { name: "Publish a social post", what: "Posts to the connected social accounts." },
  "social.analytics": { name: "Social results read", what: "Reads how posts performed." },
  "social.feedProfile": { name: "Learn the brand's posting style", what: "Reads past posts to learn how the brand writes." },
  "social.dna": { name: "Content style profile", what: "Sums up the brand's voice for future posts." },
  "social.marketSweep": { name: "Scan what the market is posting", what: "Reads competitors' and the market's posts." },
  "social.score": { name: "Score posts", what: "Scores posts before they go out." },
  "social.imageLibrary": { name: "Collect brand images", what: "Gathers the brand's images for posts." },
  "Social autopilot (scheduled)": { name: "Social autopilot (scheduled)", what: "Posts on a schedule without anyone clicking." },
  "reddit.radar": { name: "Reddit watch (scheduled)", what: "Looks for Reddit threads where the business could help." },
  "reddit.autopilot": { name: "Reddit autopilot", what: "Drafts Reddit replies on a schedule." },
  "reddit.draft": { name: "Draft a Reddit reply", what: "Writes one Reddit reply." },
  "press.opps": { name: "Find press opportunities", what: "Finds journalists asking for sources." },
  "press.pitch": { name: "Write a press pitch", what: "Drafts a pitch to a journalist." },
  "press.author": { name: "Look up a journalist", what: "Finds details about a journalist." },

  // --- Reports, onboarding, assistant ---
  "caite.turn": { name: "Chat with Caite (the platform assistant)", what: "One message to the in-app AI assistant." },
  "onboarding.prefill": { name: "Fill in the new-customer setup", what: "Pre-fills the onboarding answers from the customer's website." },
  "onboarding.draft": { name: "Draft a setup answer", what: "Drafts one onboarding answer." },
  "report.generate": { name: "Write a report", what: "Writes a customer report." },
  "briefing.run": { name: "Executive briefing", what: "Writes the executive summary email." },
  "digest.run": { name: "Scheduled summary email", what: "Writes a regular summary email." },
  "goals.recommend": { name: "Recommend goals", what: "Suggests goals for the customer." },
  "compliance.scan": { name: "Compliance scan", what: "Checks content for compliance problems." },
  "sources.plays": { name: "Find sources to get cited by", what: "Finds sites the business should get listed on." },
  "Sources: validate": { name: "Check a source site", what: "Checks whether a suggested source site is worth it." },
  "chatbot.insights": { name: "Chatbot insights", what: "Sums up what visitors ask the website chatbot." },
  "prospect.scan": { name: "Prospect scan", what: "Scans a prospect's site for a sales pitch." },

  // --- Leads ---
  "lead.brief": { name: "Write a lead brief", what: "Sums up a sales lead." },
  "lead.intent": { name: "Score a lead", what: "Scores how ready a lead is to buy." },
  "lead.campaignDraft": { name: "Draft a sales email", what: "Writes an outreach email." },
  "lead.send": { name: "Send a sales email", what: "Sends an outreach email." },
  "lead.find": { name: "Find leads", what: "Searches for new leads." },
  "lead.icp": { name: "Describe the ideal customer", what: "Writes the ideal-customer profile." },
  "Lead capture": { name: "Website lead form (free scan)", what: "Runs when someone fills in the free-scan form on aisyndicate.com. Belongs to no account." },
  "Calendly webhook": { name: "New meeting booked (Calendly)", what: "Runs when someone books a call through Calendly." },
};

/* The AI companies and the models, by the name people know. */
export const PROVIDERS = {
  anthropic: "Claude (Anthropic)",
  openai: "ChatGPT (OpenAI)",
  google: "Gemini (Google)",
  xai: "Grok (xAI)",
  perplexity: "Perplexity",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  meta: "Llama (Meta)",
  serpapi: "Google search results (SerpApi)",
  serper: "Google search results (Serper)",
  searchapi: "Search results (SearchAPI)",
  zernio: "Social posting (Zernio)",
};

function words(s) {
  return String(s)
    .replace(/^console · /, "")
    .replace(/[._/-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** { name, what, raw, known } for a job key. */
export function jobInfo(job) {
  if (!job) {
    return { name: "Not labelled (before Sep 23)", what: "Calls made before the platform started naming every job on Sep 23, 2026.", raw: null, known: true };
  }
  const hit = JOBS[job];
  if (hit) return { ...hit, raw: job, known: true };
  if (job.startsWith("console · ")) return { name: `Admin console: ${words(job)}`, what: "AI used inside this admin console.", raw: job, known: true };
  if (job.startsWith("/api/cron/")) return { name: `Scheduled job: ${words(job.slice(10))}`, what: "Runs on a timer, with nobody clicking.", raw: job, known: false };
  if (job.startsWith("/api/")) return { name: words(job.slice(5)), what: "A platform feature not yet described here.", raw: job, known: false };
  return { name: words(job), what: "Not yet described here.", raw: job, known: false };
}

const COMPANY = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", perplexity: "Perplexity",
  deepseek: "DeepSeek", groq: "Groq", mistral: "Mistral", meta: "Meta",
};

/** "Claude Sonnet 4.6 (Anthropic)" from ("anthropic", "claude-sonnet-4-6"). */
export function serviceName(provider, model) {
  const p = PROVIDERS[provider] || words(provider || "Unknown");
  if (!model) return p;
  const company = COMPANY[provider] || p;
  const parts = String(model)
    .replace(/^models\//, "")
    .replace(/^[^/]+\//, "")
    .replace(/-(\d{8}|latest)$/, "")
    .split(/[-_]/);
  /* "claude-sonnet-4-6" is version 4.6, not "4 6". */
  const merged = [];
  for (const w of parts) {
    if (/^\d+$/.test(w) && merged.length && /^\d+(\.\d+)?$/.test(merged[merged.length - 1])) merged[merged.length - 1] += `.${w}`;
    else merged.push(w);
  }
  const m = merged
    .map((w) => (/^\d/.test(w) ? w : w.replace(/^\w/, (c) => c.toUpperCase())))
    .join(" ")
    .replace(/Gpt/g, "GPT")
    .replace(/ Oss/g, " OSS");
  return `${m} (${company})`;
}
