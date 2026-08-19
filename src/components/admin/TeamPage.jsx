import { useCallback, useEffect, useState } from "react";
import { listTeam, updateTeamMember, logActivity } from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import {
  SourceBadge, Modal, Field, TextInput, Select, Explainer, timeAgo,
} from "./shared.jsx";

/* Team — who can sign in, and as what. Invite-only. */

const ROLE_META = {
  owner: { label: "Owner", blurb: "Everything, plus can add other owners", c: "#6d28d9", bg: "#f5f3ff" },
  admin: { label: "Admin", blurb: "Everything except minting owners", c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  sales: { label: "Sales rep", blurb: "Leads pages only", c: "#0369a1", bg: "#e0f2fe" },
};

export default function TeamPage({ member }) {
  const [team, setTeam] = useState({ rows: [], sample: true });
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    const t = await listTeam();
    setTeam(t);
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const setRole = async (row, role) => {
    if (row.role === "owner" && member.role !== "owner") { toast.warn("Only an owner can change another owner"); return; }
    if (role === "owner" && member.role !== "owner") { toast.warn("Only an owner can make someone an owner"); return; }
    const res = await updateTeamMember(row.user_id, { role });
    if (!res.ok) { toast.error("Couldn't change role", res.error); return; }
    toast.success("Role changed", `${row.full_name || row.email} → ${ROLE_META[role].label}`);
    load();
  };

  const toggleActive = async (row) => {
    if (row.user_id === member.user_id) { toast.warn("You can't deactivate yourself"); return; }
    if (row.role === "owner" && member.role !== "owner") { toast.warn("Only an owner can deactivate an owner"); return; }
    const verb = row.active ? "Deactivate" : "Reactivate";
    if (row.active && !window.confirm(`${verb} ${row.full_name || row.email}? They lose access the moment you confirm. Their history stays.`)) return;
    const res = await updateTeamMember(row.user_id, { active: !row.active });
    if (!res.ok) { toast.error(`${verb} failed`, res.error); return; }
    await logActivity({ actor: member.user_id, kind: "team_change", title: `${verb}d ${row.full_name || row.email}` });
    toast.success(`${verb}d`, row.email);
    load();
  };

  return (
    <>
      <Explainer
        icon="🔐"
        kicker="WHO GETS IN"
        title="Invite-only, role-gated"
        body="Owners and admins see everything. Sales reps sign in with the same door and see only the Leads pages — the database enforces it, not just the menu. Deactivating someone locks them out instantly but keeps everything they logged."
      />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
        <SourceBadge mode={team.sample ? "sample" : "live"} />
        <button className="btn btn-accent" onClick={() => setInviteOpen(true)}>+ Invite teammate</button>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="adm-table">
          <thead><tr><th>Person</th><th>Role</th><th>Access</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {team.rows.map((row) => {
              const rm = ROLE_META[row.role] || ROLE_META.admin;
              return (
                <tr key={row.user_id} style={{ opacity: row.active ? 1 : 0.55 }}>
                  <td>
                    <div style={{ fontWeight: 600, color: "var(--ink)" }}>
                      {row.full_name || "—"}{row.user_id === member.user_id && <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--ink-faint)", marginLeft: 8 }}>YOU</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{row.email}</div>
                  </td>
                  <td>
                    <Select
                      style={{ width: 130, padding: "6px 10px", fontSize: 12.5 }}
                      value={row.role}
                      onChange={(e) => setRole(row, e.target.value)}
                      options={Object.entries(ROLE_META).map(([k, m]) => [k, m.label])}
                    />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-dim)" }}>{rm.blurb}</td>
                  <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{row.created_at ? timeAgo(row.created_at) : "—"}</td>
                  <td>
                    <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12, color: row.active ? "var(--danger)" : "#006b1a" }} onClick={() => toggleActive(row)}>
                      {row.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {inviteOpen && <InviteModal member={member} onClose={() => setInviteOpen(false)} reload={load} />}
    </>
  );
}

function InviteModal({ member, onClose, reload }) {
  const [f, setF] = useState({ email: "", fullName: "", role: "sales" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const invite = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { toast.warn("Check the email address"); return; }
    if (!isConfigured()) {
      toast.info("Preview mode", "Real invites send once Supabase is wired. The flow: they get an email, set a password, and land straight in the console with this role.");
      onClose();
      return;
    }
    setBusy(true);
    const res = await apiFetch("/api/invite", { method: "POST", body: f });
    setBusy(false);
    if (!res.ok) { toast.error("Invite failed", res.error); return; }
    await logActivity({ actor: member.user_id, kind: "team_invite", title: `Invited ${f.email} as ${f.role}` });
    toast.success("Done", res.data.message);
    onClose(); reload();
  };

  return (
    <Modal open onClose={onClose} kicker="TEAM" title="Invite a teammate" width={520}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={invite} disabled={busy}>{busy ? "Sending…" : "Send invite"}</button>
      </>}>
      <Field label="Email"><TextInput type="email" value={f.email} onChange={set("email")} placeholder="rep@aisyndicate.com" /></Field>
      <Field label="Name"><TextInput value={f.fullName} onChange={set("fullName")} placeholder="First Last" /></Field>
      <Field label="Role" hint={ROLE_META[f.role].blurb}>
        <Select value={f.role} onChange={set("role")} options={
          Object.entries(ROLE_META)
            .filter(([k]) => k !== "owner" || member.role === "owner")
            .map(([k, m]) => [k, m.label])
        } />
      </Field>
      <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.55 }}>
        They get an email from Supabase, set a password, and land in the console with exactly this
        role. If the email already has a platform account, access is granted instantly instead.
      </p>
    </Modal>
  );
}
