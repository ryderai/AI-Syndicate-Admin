# Every key the platform runs on

Read out of the platform's own Vercel project (`ai-syndicate`, team `aisyndicate`) on
**Sunday, August 16 2026**. 131 variables, of which **58 are real credentials** — the other
73 are on/off feature flags and Stripe price IDs, which are settings, not secrets.

**"Sensitive" means Vercel will never hand it back.** Write-only. Not by the dashboard, not by
the API, not by the person who saved it. Those have to be re-made at their source. "Encrypted"
means it can be read back one at a time. That split is marked on every row below.

---

## Tier 1 — needed to build ANYTHING real (5 keys)

Nothing works without these. This is the same short list as before.

| Key | Vercel | What it turns on |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | 🔒 sensitive | Login, roles, saved data, the platform sign-in button |
| `VITE_SUPABASE_URL` | ✅ have it | — |
| `VITE_SUPABASE_ANON_KEY` | ✅ have it | — |
| `ANTHROPIC_API_KEY` | 🔒 sensitive | Every AI feature. Caite runs on this |
| `STRIPE_SECRET_KEY` | 🔒 sensitive | Money, plans, who is on what tier |

---

## Tier 2 — the AI engines the platform actually asks questions to (7 keys)

This is what makes GEO measurement possible: the prompt simulator, citation tracker,
brand intel, hallucination watch and competitor share-of-voice all work by asking the
same question to many engines and reading who gets named.

| Key | Vercel | Engine |
|---|---|---|
| `OPENAI_API_KEY` | 🔒 sensitive | ChatGPT |
| `PERPLEXITY_API_KEY` | 🔒 sensitive | Perplexity |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`) | 🔒 sensitive | Google Gemini |
| `XAI_API_KEY` | 🔒 sensitive | Grok |
| `DEEPSEEK_API_KEY` | 🔒 sensitive | DeepSeek |
| `MISTRAL_API_KEY` | 🔒 sensitive | Mistral |
| `GROQ_API_KEY` | 🔒 sensitive | Groq (fast open models) |

**All seven are separate paid accounts.** If the goal is only "prove the feature works", two
or three is enough to build against — the code path is identical per engine. Ten engines is a
billing decision, not a build one.

---

## Tier 3 — real-world measurement, not AI (8 keys)

Where the platform gets facts instead of opinions.

| Key | Vercel | What it measures |
|---|---|---|
| `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN` | 🔒 sensitive | Google Search Console — real clicks and queries |
| `SERPAPI_KEY` and `SERP_API_KEY` | 🔒 sensitive | Live Google results. **Two different names exist** — worth asking which one the code reads before paying for both |
| `PAGESPEED_API_KEY` | 🔒 sensitive | Google PageSpeed — the speed half of the SEO score |
| `YELP_API_KEY` | 🔒 sensitive | Reviews / reputation |
| `YOUTUBE_API_KEY` | 🔒 sensitive | Video presence |
| `MONITOR_INCLUDE_SERP` | ✅ readable | A setting, not a key |

---

## Tier 4 — publishing and outreach (13 keys)

The platform doesn't only measure; it ships and sends.

| Key | Vercel | What it does |
|---|---|---|
| `RESEND_API_KEY` | ✅ have it | Sends email |
| `APOLLO_API_KEY` | 🔒 sensitive | Finds contact details for prospecting |
| `INSTANTLY_API_KEY` + `INSTANTLY_CAMPAIGN_ID` | 🔒 / ✅ | Cold email sequences |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | 🔒 sensitive | Knows when someone books |
| `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` | 🔒 sensitive | Social publishing |
| `PINTEREST_APP_ID` + `PINTEREST_APP_SECRET` | 🔒 sensitive | Social publishing |
| `SHOPIFY_APP_CLIENT_ID` + `_SECRET` | ✅ / 🔒 | Reads a client's Shopify store |
| `WIKIDATA_OAUTH_CLIENT_ID` + `_SECRET` + `_REDIRECT_URI` | 🔒 sensitive | Edits the client's Wikidata entry — a real GEO lever |
| `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET` | ✅ / 🔒 | Image generation |

---

## Tier 5 — plumbing, only needed if we run our own copy (10 keys)

These belong to the running deployment, not to a feature. If we build inside the existing
platform we inherit them; if we ever stand up a second copy, they get made fresh — they are
not things to ask anyone for.

`KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `REDIS_URL`
(caching) · `CRON_SECRET` (password on the scheduled jobs) · `FLAGS_SECRET`,
`EXPERIMENTATION_CONFIG_ITEM_KEY`, `STATSIG_SERVER_API_KEY`, `NEXT_PUBLIC_STATSIG_CLIENT_KEY`
(feature flags) · `CMS_SECRET_KEY` + `CMS_SECRET_KEY_ID` · `LEAD_VERIFY_SECRET` ·
`STRIPE_WEBHOOK_SECRET` + `STRIPE_PUBLISHABLE_KEY` · `ZERNIO_API_KEY` ·
`SUPABASE_URL` / `SUPABASE_ANON_KEY` (server-side aliases of the two we already have) ·
`OPS_ALERT_EMAILS`, `TWILIO_STATUS_ALERT_EMAIL`, `PUBLIC_BASE_URL`.

---

## What to actually ask for

Asking for all 58 gets a "let me think about it". Asking in this order gets a yes each time:

1. **Supabase Owner or Developer access** for `ryder@aisyndicate.com`. Unblocks the service
   key *and* the migrations. One ask, two blockers gone.
2. **`ANTHROPIC_API_KEY`** — a new key on the existing account. Same bill.
3. **A restricted read-only `STRIPE_SECRET_KEY`.**
4. **`OPENAI_API_KEY` + `PERPLEXITY_API_KEY`** — two engines is enough to build and prove
   every multi-engine feature. The rest are copies of the same code path.
5. **`GSC_*` and `PAGESPEED_API_KEY`** — the real-numbers half of any score we report.

Everything below that is a feature-by-feature ask, worth making when we build that feature and
not before. A key sitting unused in an env file is a liability, not an asset.

## The two things worth flagging while asking

- **`SERPAPI_KEY` and `SERP_API_KEY` both exist** with different values. One of them is
  probably dead and still being paid for. Worth 30 seconds of Andrew's time to say which.
- **Every 🔒 key in this document is unreadable from Vercel.** If the only copy of any of them
  lives in that project and nowhere else, the value is effectively lost — rotating it is the
  only way to ever see it again. A Bitwarden entry per key fixes that permanently.
