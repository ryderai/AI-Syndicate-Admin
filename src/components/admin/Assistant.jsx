import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../../lib/adminApi.js";
import { onScreenContext } from "../../lib/screenContext.js";
import { toast } from "../../lib/toast.js";

/* The always-on assistant.
 *
 * Mounted once by AdminDashboard, so it is on every page and keeps its
 * conversation when you move between them — the whole point is that you can
 * open a lead, ask about it, go to Operations, and it still knows what you
 * were talking about.
 *
 * THREE THINGS ON SCREEN THAT ARE NOT DECORATION
 *
 * 1. THE "LOOKING AT" CHIP. Shows exactly what the assistant can see of your
 *    screen. If it says "Leads · Sarah Chen", that is what travels. Nothing
 *    else does. It is on the outside of the panel because a person should not
 *    have to trust a description of what is shared — they should be able to
 *    read it.
 *
 * 2. THE ACTIONS SWITCH. On by default. Off means the assistant can read
 *    everything and change nothing, and it is told so, so it says what it
 *    would have done instead of failing quietly.
 *
 * 3. THE RECEIPTS. Every change it makes prints as its own line under the
 *    answer — green for done, red for refused. Never buried in a paragraph.
 *    An action you cannot see is an action you cannot undo.
 *
 * The conversation is kept in memory only. Refresh and it is gone. That is
 * deliberate: what matters from a chat gets kept by the remember tool as a
 * memory you can read and delete on the Brain page, not as a transcript of
 * everything anyone ever typed.
 */

const GREETING = {
  role: "assistant",
  text: "Ask me anything about what is going on here — who is owed a call, what is late, where a client stands. "
    + "I read the real records before I answer. I can also do things: move a lead, log a call, set a follow-up, add a task.",
  intro: true,
};

function Bubble({ m }) {
  const isAgent = m.role === "assistant";
  return (
    <div style={{ display: "flex", justifyContent: isAgent ? "flex-start" : "flex-end", marginBottom: 10 }}>
      <div style={{
        maxWidth: "88%",
        padding: "9px 12px",
        borderRadius: 12,
        background: isAgent ? "var(--bg-2)" : "var(--ink)",
        color: isAgent ? "var(--ink-2)" : "white",
        border: isAgent ? "1px solid var(--rule)" : "none",
        fontSize: 13,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {m.text}
      </div>
    </div>
  );
}

/* One line per thing the assistant actually did. Deliberately plain and
 * deliberately loud — this is the receipt. */
function ActionReceipt({ a }) {
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "flex-start",
      padding: "7px 10px", marginBottom: 6, borderRadius: 9,
      background: a.ok ? "var(--success-soft, #eafce9)" : "#fef2f2",
      border: `1px solid ${a.ok ? "#b9e6b3" : "#fecaca"}`,
      fontSize: 12, lineHeight: 1.5,
    }}>
      <span aria-hidden="true" style={{ flexShrink: 0 }}>{a.ok ? "✓" : "✕"}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", color: a.ok ? "#006b1a" : "var(--danger)", marginRight: 6 }}>
          {a.ok ? "DID THIS" : "DID NOT RUN"}
        </span>
        <span style={{ color: "var(--ink-2)" }}>{a.text}</span>
      </span>
    </div>
  );
}

export default function Assistant({ member }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowActions, setAllowActions] = useState(true);
  const [screen, setScreen] = useState(null);
  const [lastContext, setLastContext] = useState(null);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => onScreenContext(setScreen), []);

  // Cmd/Ctrl+K opens it from anywhere. Escape closes it, but only when the
  // panel itself has focus — otherwise it would swallow Escape from a modal
  // underneath and people would not be able to close their own dialogs.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 40);
  }, [open]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async (text) => {
    const q = String(text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    const history = messages
      .filter((m) => !m.intro && m.text)
      .slice(-10)
      .map((m) => ({ role: m.role, text: m.text }));
    setMessages((c) => [...c, { role: "user", text: q }]);
    setBusy(true);

    const res = await apiFetch("/api/ai-chat", {
      method: "POST",
      body: { message: q, history, screen, allowActions },
    });
    setBusy(false);

    if (!res.ok) {
      setMessages((c) => [...c, {
        role: "assistant",
        text: res.preview
          ? "This is preview mode — there are no real records to read and no AI key set, so I cannot answer for real. "
            + "With the keys in place I read every client, task, lead, email and follow-up before answering, and I can change records for you."
          : `I could not answer that: ${res.error}`,
      }]);
      return;
    }

    setLastContext(res.data.context || null);
    setMessages((c) => [...c, {
      role: "assistant",
      text: res.data.text,
      actions: res.data.actions || [],
      cappedOut: res.data.cappedOut,
    }]);

    // Anything that changed a record means the page underneath is now out of
    // date. The same refresh event every page already listens for.
    if ((res.data.actions || []).some((a) => a.ok && a.tool !== "search")) {
      window.dispatchEvent(new CustomEvent("adm-refresh"));
      toast.info("The assistant changed a record", "The page has been refreshed.");
    }
  }, [input, busy, messages, screen, allowActions]);

  const looking = screen
    ? [screen.page, screen.record?.label || screen.label].filter(Boolean).join(" · ")
    : "nothing in particular";

  const panelWidth = big ? "min(720px, calc(100vw - 32px))" : "min(420px, calc(100vw - 32px))";

  return createPortal(
    <>
      {/* The button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close the assistant" : "Open the assistant"}
        title="Assistant — Ctrl+K"
        style={{
          position: "fixed", right: 20, bottom: 20, zIndex: 9000,
          width: 52, height: 52, borderRadius: 99, border: 0, cursor: "pointer",
          background: "linear-gradient(135deg, var(--accent-2), var(--accent-3))",
          color: "white", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 8px 24px rgba(10, 34, 69, 0.28)",
        }}
      >
        {open ? "×" : "✦"}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Console assistant"
          style={{
            position: "fixed", right: 20, bottom: 84, zIndex: 9000,
            width: panelWidth, maxHeight: "min(76vh, 720px)",
            display: "flex", flexDirection: "column",
            background: "white", borderRadius: 16, border: "1px solid var(--rule)",
            boxShadow: "0 24px 60px rgba(10, 34, 69, 0.22)", overflow: "hidden",
          }}
        >
          {/* Head */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--rule)", background: "linear-gradient(135deg, #faf5ff, white)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", flex: 1 }}>Assistant</div>
              <button className="btn btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}
                onClick={() => setBig((v) => !v)} title={big ? "Make it narrow" : "Make it wide"}>
                {big ? "⇥" : "⇤"}
              </button>
              <button className="btn btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}
                onClick={() => { setMessages([GREETING]); setLastContext(null); }} title="Start again">
                Clear
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%",
                padding: "3px 9px", borderRadius: 99, background: "var(--accent-soft)",
                fontSize: 11, color: "var(--accent-deep)", fontWeight: 600,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }} title="This is everything the assistant can see of your screen.">
                👁 Looking at: {looking}
              </span>

              <button
                onClick={() => setAllowActions((v) => !v)}
                title={allowActions
                  ? "The assistant can change records. Click to make it read-only."
                  : "The assistant can read but cannot change anything. Click to let it act."}
                style={{
                  marginLeft: "auto", padding: "3px 9px", borderRadius: 99, cursor: "pointer",
                  border: `1px solid ${allowActions ? "#b9e6b3" : "var(--rule)"}`,
                  background: allowActions ? "var(--success-soft, #eafce9)" : "var(--bg-3, #f1f5f9)",
                  color: allowActions ? "#006b1a" : "var(--ink-dim)",
                  fontSize: 11, fontWeight: 700, fontFamily: "var(--body)",
                }}
              >
                {allowActions ? "Actions on" : "Actions off"}
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: 14, minHeight: 220 }}>
            {messages.map((m, i) => (
              <div key={i}>
                <Bubble m={m} />
                {(m.actions || []).map((a, j) => <ActionReceipt key={j} a={a} />)}
                {m.cappedOut && (
                  <div style={{ fontSize: 11.5, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "6px 9px", marginBottom: 8 }}>
                    I hit my step limit on that one, so treat the answer as unfinished.
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div style={{ fontSize: 12, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>
                READING THE RECORDS…
              </div>
            )}
            {messages.length === 1 && (
              <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
                {[
                  "What needs my attention today?",
                  "Who has not been called in over a week?",
                  "What is late, and for which client?",
                ].map((s) => (
                  <button key={s} className="btn" style={{ padding: "7px 10px", fontSize: 12, textAlign: "left", justifyContent: "flex-start" }}
                    onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* What the last answer was built on. A thin answer and a thin
              dataset look identical without this. */}
          {lastContext && (
            <div style={{ padding: "6px 14px", borderTop: "1px solid var(--rule)", background: "var(--bg-1)", fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--ink-faint)", letterSpacing: "0.03em" }}>
              READ {Object.entries(lastContext.counts || {}).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(" · ") || "nothing"}
              {lastContext.unreadable?.length ? ` · COULD NOT READ: ${lastContext.unreadable.join(", ")}` : ""}
            </div>
          )}

          {/* Input */}
          <div style={{ padding: 10, borderTop: "1px solid var(--rule)", display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              ref={inputRef}
              className="adm-input"
              rows={1}
              placeholder={`Ask about anything here, ${(member.full_name || "").split(" ")[0] || "or tell me what to do"}…`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              style={{ resize: "none", minHeight: 38, maxHeight: 120, flex: 1, fontFamily: "var(--body)" }}
            />
            <button className="btn btn-accent" onClick={() => send()} disabled={busy || !input.trim()}>
              {busy ? "…" : "Ask"}
            </button>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
