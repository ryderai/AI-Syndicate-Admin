# The Notion merge — what is left, in order

Written overnight Mon 31 Aug 2026. Everything here takes about ten minutes.

**Where things stand:** the six clients are already in the live console. The 107 tasks and the
eight reps are built and tested but **not pushed**, so they need a deploy first.

---

## 1. Push and deploy

Open the repo in Cursor and push as normal. Nothing from 30–31 Aug is live, so this deploy
carries several sessions' work, not only mine.

## 2. Put the 107 tasks in

1. Open **https://ai-syndicate-admin.vercel.app/#/dashboard/operations**
2. Click **Bring tasks over from Notion** (next to + New task, top right)
3. Open `ai-syndicate-admin/_merge/notion-tasks-2026-08-31.json`, select all, copy
4. Paste it into the big box on that screen
5. Click **Check it first**
6. It should say **107 new · 0 updated · 0 already right** and nothing refused.
   If it says anything is refused, read the yellow box — it names the row and the reason.
7. Click **Bring them over (107)**

Pasting it twice is safe. The second time it will say 0 new.

## 3. Give the sheet's reps their accounts

1. Open **https://ai-syndicate-admin.vercel.app/#/dashboard/sales**
2. Click the **⋯** button (right of the Everybody dropdown)
3. Click **Reps on the sheet**
4. You will see seven people to create: Brandon Roberts, Larry Pike, Cameron, Troy,
   Hunter Grant, Matt Brown, Sawyer
5. **If you know any of their real work email addresses, type them into the Email box on
   their row.** If you leave a box empty they get a placeholder address that can never
   receive mail, which is fine — it exists only so their claimed leads land back on them.
6. Click the purple button at the bottom

**Nobody gets emailed by this.** Not one message is sent.

"Andrew" will be shown separately with a warning. It has 1 row, and the only person close is
Andrew Soncini — but only the first name matches, and a first name is not enough to hand
somebody a pipeline. Decide that one yourself.

## 4. Then, when you have their emails

Team page → Invite → their real address → role Sales rep. That sends the proper invite and
they set their own password. Their placeholder account can then be switched off.

---

## Three things only you can do

1. **A GoDaddy password is sitting in plain text in Notion.** The task page "Get access to
   Website and Google Tools" (Michelle Creamer) has a customer number and a password typed
   into it. I did **not** copy them into the console. Put both in Bitwarden, then delete them
   off the Notion page.
2. **Justin Dyar has no start date**, so nobody can say which week he is on. His stage reads
   "Ongoing" as a placeholder and his notes say so. Set the start date and the week follows.
3. **`ZZ TEST — Dry Run Realty` is still in the client list.** Its four tasks can be deleted
   from the task modal; the client itself cannot be deleted from the console at all.
