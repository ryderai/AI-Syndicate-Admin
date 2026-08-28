# The Google app — one pass

Fri Aug 28 2026. Turns on the Inbox page AND reading a client's Search Console,
Business Profile and Analytics. One app covers all of it.

Sign in to console.cloud.google.com as ryder@aisyndicate.com first.

---

## A. Make the project

1. Click the project dropdown in the top bar.
2. Click **New Project**.
3. Name: `AI Syndicate Admin`
4. Click **Create**. Wait for it, then pick it in that same dropdown.

## B. Switch on seven APIs

For each one: type the name in the search bar at the top, click the result,
click **Enable**, then come back to the search bar.

5. `Gmail API`
6. `Google Search Console API`
7. `Google Analytics Data API`
8. `Google Analytics Admin API`
9. `My Business Account Management API`
10. `My Business Business Information API`
11. `Business Profile Performance API`

The last three often show **Request access** instead of **Enable**. Fill the form
in if so. Google reviews those by hand and we have never been through it, so do
not promise anybody a date. The first four work straight away.

## C. The consent screen

12. Search **OAuth consent screen**, click it.
13. User Type: pick **Internal**. (Only @aisyndicate.com accounts can connect.
    That is what we want.)
14. App name: `AI Syndicate Admin`
15. Support email: ryder@aisyndicate.com
16. Save through the rest. Defaults are fine.

## D. Add the three permissions

17. Left menu → **APIs & Services** → **OAuth consent screen**.
    (Newer projects call this **Google Auth Platform** → **Data Access**.)
18. Press **ADD OR REMOVE SCOPES**.
19. Paste each of these into the filter box and tick it:

        https://www.googleapis.com/auth/webmasters.readonly
        https://www.googleapis.com/auth/analytics.readonly
        https://www.googleapis.com/auth/business.manage

20. Press **UPDATE**, then **SAVE**.

## E. Create the app itself

21. Left menu → **APIs & Services** → **Credentials**.
22. Click **+ Create credentials** → **OAuth client ID**.
23. Application type: **Web application**
24. Name: `admin-console`
25. Under **Authorized redirect URIs**, click **+ ADD URI** and paste these
    FOUR, one at a time, exactly:

        https://ai-syndicate-admin.vercel.app/api/gmail-callback
        https://ai-syndicate-admin.vercel.app/api/connect-callback
        http://localhost:5173/api/gmail-callback
        http://localhost:5173/api/connect-callback

    The two localhost ones are not optional. Without them the sign-in fails on
    your Mac with `redirect_uri_mismatch`.

26. Click **Create**.
27. Copy the **Client ID** and the **Client secret**. Keep the box open.

## F. Put them in .env.local

28. In Cursor open `.env.local` and fill these four lines:

        GOOGLE_OAUTH_CLIENT_ID=<the Client ID>
        GOOGLE_OAUTH_CLIENT_SECRET=<the Client secret>
        GMAIL_REDIRECT_URI=http://localhost:5173/api/gmail-callback
        CONNECT_REDIRECT_URI=http://localhost:5173/api/connect-callback

29. Save. Put both in Bitwarden too.
30. Terminal: **Ctrl+C**, then `npm run dev`

## G. Prove it

31. Open `localhost:5173` → **Inbox** in the sidebar.
32. Click **Connect your Gmail**.
33. Approve on Google's screen.
34. Your last 25 threads should appear. That is the proof.

---

## Notes

- The two `*_REDIRECT_URI` lines are LOCAL ONLY. When we do Vercel, leave both
  blank there — the deployed site works its own address out.
- SETUP.md says `admin.aisyndicate.com`. That domain does not exist yet. If it
  ever gets set up, add its two callback addresses to the same list in step 25.
- The console asks Google for **modify + send** on Gmail, so a status set here
  also shows in Gmail. `gmail.modify` cannot permanently delete a message or
  empty the bin. We never ask for that.
- Because the app is **Internal**, a client cannot sign in here. The order is:
  the client adds our address to their Search Console / Business Profile /
  Analytics first, then we sign in with our own account.
- Migration 0013 already ran this morning, so the Connections tab will save.
