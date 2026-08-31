# What is left, in order

Updated Mon 31 Aug 2026, afternoon.

**Where things stand:** the six clients and all 107 Notion tasks are live in the console.
Three new things are built and tested but **not deployed**: deleting a client, two people on
one task, and the task side panel.

---

## 1. Run one piece of SQL — 30 seconds

This has to happen **before** the deploy is useful. (It is safe either way — the app falls
back if the column is missing and tells you so — but nothing multi-person works until it is
in.)

1. Open **supabase.com** → your project → **SQL Editor** → **New query**
2. Open the file `ai-syndicate-admin/supabase/migrations/0028_task_assignees.sql`
3. Select all of it, copy, paste into the SQL editor
4. Click **Run**

It is safe to run twice. It adds the `assignees` column, gives every task that already has
somebody a one-name list, and adds a rule that keeps the two fields from ever disagreeing.

## 2. Push and deploy

Open the repo in Cursor and push as normal.

## 3. Delete the test client — 20 seconds

1. Open **https://ai-syndicate-admin.vercel.app/#/dashboard/clients**
2. Click **Open →** on `ZZ TEST — Dry Run Realty`
3. Click **Edit** (top right of the client card)
4. Scroll to the bottom of that box → **Delete this client…**
5. Read what it says goes with it. Its 4 tasks go too.
6. Type `ZZ TEST — Dry Run Realty` in the box
7. Click **Delete for good**

There is no undo. That is why the button is behind a fold and asks you to type the name.

## 4. Give the sheet's reps their accounts — still the last piece

1. Open **https://ai-syndicate-admin.vercel.app/#/dashboard/sales**
2. Click the **⋯** button (right of the Everybody dropdown)
3. Click **Reps on the sheet**
4. Seven people to create: Brandon Roberts, Larry Pike, Cameron, Troy, Hunter Grant,
   Matt Brown, Sawyer
5. If you know any of their real work email addresses, type them in. If you leave a box
   empty they get a placeholder address that can never receive mail — that is fine, it only
   exists so their claimed leads land back on them.
6. Click the purple button at the bottom

**Nobody gets emailed by this.** Not one message is sent.

"Andrew" is shown separately with a warning: it has 1 row and the only person close is
Andrew Soncini, but only the first name matches, and a first name is not enough to hand
somebody a pipeline. That one is your call.

---

## Optional, once step 1 and 2 are done

**Put the second person back on the 12 Notion tasks that had two.** Operations → Bring tasks
over from Notion → paste `_merge/notion-tasks-2026-08-31.json` → Check it first. It will show
12 updates and nothing else. Pasting it is safe as many times as you like.

---

## Three things only you can do

1. **A GoDaddy password is sitting in plain text in Notion.** The task page "Get access to
   Website and Google Tools" (Jessica Mackrael) has a customer number and a password typed
   into it. It was **not** copied into the console. Put both in Bitwarden, then delete them
   off the Notion page.
2. **Justin Dyar has no start date**, so nobody can say which week he is on. His stage reads
   "Ongoing" as a placeholder and his notes say so. Set the start date and the week follows.
3. **Real email addresses for the seven reps**, so their placeholder accounts can become
   real logins from the Team page.
