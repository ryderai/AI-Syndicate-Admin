# Do this, in order

1. In Terminal, press the down arrow to **AI Syndicate**. Press Enter.

2. Type `y` and press Enter.

3. Type `ai-syndicate` and press Enter.

4. Paste this and press Enter:

       npx vercel env pull .env.local --environment=production

5. Paste this and press Enter:

       open -e .env.local

6. In the file that opens, find these 8 lines and copy them into a new blank
   TextEdit document. Skip any that have nothing after the `=` sign.

       VITE_SUPABASE_URL
       VITE_SUPABASE_ANON_KEY
       SUPABASE_SERVICE_ROLE_KEY
       ANTHROPIC_API_KEY
       RESEND_API_KEY
       OPENAI_API_KEY
       PERPLEXITY_API_KEY
       GEMINI_API_KEY

7. In Chrome, open:

       vercel.com/aisyndicate/ai-syndicate-admin/settings/environment-variables

8. Delete every row on that page. Click the `...` on a row, click Remove, confirm.
   Repeat until the page is empty.

9. Click **Add Environment Variable**.

10. Paste your 8 copied lines into the Key box.

11. Tick Production, Preview and Development.

12. Click Save.

13. Click **Add Environment Variable** again and add these six, one at a time,
    ticking all three environments each time:

        ADMIN_BASE_URL          https://ai-syndicate-admin.vercel.app
        PLATFORM_URL            https://aisyndicate.com
        VITE_PLATFORM_URL       https://aisyndicate.com
        PLATFORM_ACCOUNT_EMAIL  copy from your .env.local on the Mac
        USAGE_INGEST_KEY        copy from your .env.local on the Mac
        VITE_NO_SIGNIN          false

14. In Terminal, paste this and press Enter:

        openssl rand -base64 32

15. Copy the line it prints. Add it in Vercel as `VAULT_KEY`. Save it in Bitwarden too.

16. Click **Deployments** in the left sidebar.

17. Click the newest deployment.

18. Click `...` then **Redeploy**. Confirm. Wait for Ready.

19. Open:

        https://ai-syndicate-admin.vercel.app/api/health

20. If it says **Not authorized** or **401** — done, it works.
    If it still says **Supabase env vars are missing** — go back to step 11.

21. In Terminal, paste this and press Enter:

        cd ~/Desktop && rm -rf keys-pull

## Two rules

- Do not copy `STRIPE_SECRET_KEY` from the platform.
- Do not touch the `ai-syndicate` project's variables. Only `ai-syndicate-admin`.
