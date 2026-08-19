/* POST /api/gmail-modify — change what Gmail itself thinks about a thread.
 *
 * Auth: member, for a mailbox they may work.
 * Body: { account, threadId,
 *         markRead?, markUnread?, archive?, unarchive?, star?, unstar?,
 *         addLabels?: [names], removeLabels?: [names],
 *         done?: true|false,
 *         clientLabel?: "Michelle Creamer" | null }
 *
 * done:true  = archive + add AIS/Done.  done:false = put it back in the inbox
 * and take AIS/Done off. The label name lives on the server so the browser
 * cannot invent a different one and split the same idea across two labels.
 *
 * This endpoint ONLY talks to Gmail. It never writes a status — the page saves
 * that first and then calls this, so the two stay in step. Do not add a Gmail
 * action to the UI without deciding what it means for our status: an earlier
 * "Archive in Gmail" button archived the mail and left the status alone, so a
 * finished thread sat in Needs reply forever. gmailEffectOfStatus() in
 * src/components/admin/Inbox.jsx is now the single place that mapping lives.
 *
 * clientLabel is exclusive: linking a thread to a client removes any other
 * AIS/Client/... label first, so a thread never claims two clients.
 *
 * It can NEVER delete. The Google permission we ask for (gmail.modify) has no
 * power to permanently delete a message or empty the bin.
 */

import { requireMember, readJson } from "../lib/supabase-server.js";
import { accessTokenFromRefresh, gmailFetch } from "../lib/google-oauth.js";
import {
  resolveMailbox, ensureLabels, clientLabelIds, clientLabelName, DONE_LABEL,
} from "../lib/gmail-mailbox.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  const body = await readJson(req);
  const threadId = String(body?.threadId || "").trim();
  if (!threadId) return res.status(400).json({ error: "Missing threadId." });

  const box = await resolveMailbox(member, body?.account);
  if (box.error) return res.status(box.status).json({ error: box.error });
  if (box.needsReconnect) {
    return res.status(409).json({
      needsReconnect: true,
      error: "This mailbox was connected before the console could label or archive mail. Disconnect it and connect it again once — Google will ask for the extra permission.",
    });
  }

  const addNames = Array.isArray(body?.addLabels) ? body.addLabels : [];
  const removeNames = Array.isArray(body?.removeLabels) ? body.removeLabels : [];
  const clientLabel = body?.clientLabel === null ? null : (body?.clientLabel ? String(body.clientLabel) : undefined);

  try {
    const token = await accessTokenFromRefresh(box.refreshToken);

    const addLabelIds = [];
    const removeLabelIds = [];

    if (body?.markRead) removeLabelIds.push("UNREAD");
    if (body?.markUnread) addLabelIds.push("UNREAD");
    if (body?.archive) removeLabelIds.push("INBOX");
    if (body?.unarchive) addLabelIds.push("INBOX");
    if (body?.star) addLabelIds.push("STARRED");
    if (body?.unstar) removeLabelIds.push("STARRED");

    // Named labels we have to look up or create.
    const wantAdd = [...addNames];
    const wantRemove = [...removeNames];
    if (clientLabel) wantAdd.push(clientLabelName(clientLabel));
    if (body?.done === true) { wantAdd.push(DONE_LABEL); removeLabelIds.push("INBOX"); }
    if (body?.done === false) { wantRemove.push(DONE_LABEL); addLabelIds.push("INBOX"); }

    const map = await ensureLabels(token, [...wantAdd, ...wantRemove]);
    for (const n of wantAdd) if (map[n]) addLabelIds.push(map[n]);
    for (const n of wantRemove) if (map[n]) removeLabelIds.push(map[n]);

    // Re-linking or unlinking a client: strip every other client label.
    if (clientLabel !== undefined) {
      const all = await clientLabelIds(token);
      const keep = clientLabel ? map[clientLabelName(clientLabel)] : null;
      for (const id of all) if (id !== keep) removeLabelIds.push(id);
    }

    const payload = {};
    const add = [...new Set(addLabelIds)];
    const remove = [...new Set(removeLabelIds)].filter((id) => !add.includes(id));
    if (add.length) payload.addLabelIds = add;
    if (remove.length) payload.removeLabelIds = remove;
    if (!payload.addLabelIds && !payload.removeLabelIds) {
      return res.status(200).json({ ok: true, changed: false });
    }

    await gmailFetch(token, `/threads/${encodeURIComponent(threadId)}/modify`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return res.status(200).json({ ok: true, changed: true, applied: payload });
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 502;
    return res.status(status).json({ error: `Gmail: ${err.message}` });
  }
}
