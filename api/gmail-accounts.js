/* GET    /api/gmail-accounts                       — mailboxes the caller may work
 * PATCH  /api/gmail-accounts                       — share/unshare or rename one
 * DELETE /api/gmail-accounts?account=<email>       — disconnect one
 *
 * "Mailboxes the caller may work" = the ones they connected themselves, plus
 * any mailbox marked shared IF they are an owner/admin. See lib/gmail-mailbox.js.
 * Only the person who connected a mailbox can share, rename or disconnect it,
 * so nobody can quietly expose a teammate's personal mail.
 */

import { requireMember, getAdminSupabase, readJson } from "../lib/supabase-server.js";
import { listMailboxesFor } from "../lib/gmail-mailbox.js";

const ADMIN_ROLES = ["owner", "admin"];

export default async function handler(req, res) {
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  const admin = getAdminSupabase();

  if (req.method === "GET") {
    const { mailboxes, error } = await listMailboxesFor(member);
    if (error) return res.status(500).json({ error });
    res.setHeader("Cache-Control", "private, no-store");
    // accounts: kept as the field name so nothing that already reads this
    // endpoint breaks. mailboxes is the same array under a clearer name.
    return res.status(200).json({ accounts: mailboxes, mailboxes, role: member.membership.role });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    const account = String(body?.account || "").trim();
    if (!account) return res.status(400).json({ error: "Missing account." });

    const patch = {};
    if (typeof body?.shared === "boolean") patch.shared = body.shared;
    if (typeof body?.display_name === "string") patch.display_name = body.display_name.trim().slice(0, 80) || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to change." });

    // Sharing a mailbox with the team is an owner/admin decision, and only
    // over your OWN connection.
    if (patch.shared === true && !ADMIN_ROLES.includes(member.membership.role)) {
      return res.status(403).json({ error: "Only an owner or admin can share a mailbox with the team." });
    }

    const { data, error } = await admin
      .from("admin_gmail_accounts")
      .update(patch)
      .eq("user_id", member.user.id)
      .eq("email_address", account)
      .select("email_address, shared, display_name")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) {
      return res.status(403).json({
        error: "You can only change a mailbox you connected yourself. Whoever connected this one can share it.",
      });
    }
    return res.status(200).json({ ok: true, account: data });
  }

  if (req.method === "DELETE") {
    const account = Array.isArray(req.query?.account) ? req.query.account[0] : req.query?.account;
    if (!account) return res.status(400).json({ error: "Missing account." });
    // Own connection only — deleting the row a teammate created is not ours to do.
    const { data, error } = await admin
      .from("admin_gmail_accounts")
      .delete()
      .eq("user_id", member.user.id)
      .eq("email_address", account)
      .select("email_address");
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) {
      return res.status(403).json({ error: "You can only disconnect a mailbox you connected yourself." });
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed." });
}
