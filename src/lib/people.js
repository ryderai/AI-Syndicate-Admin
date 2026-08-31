/* NAMING A TEAMMATE SO THE RIGHT ONE GETS THE WORK.
 *
 * Every person picker in this console drew `m.full_name || m.email`. That is
 * right until two members share a name, and then it is the worst kind of wrong:
 * two identical rows in a dropdown, no way to tell them apart, and a task
 * assigned to the wrong one DISAPPEARS — it is not on that person's Work page,
 * it is on somebody else's, and nothing anywhere says so.
 *
 * That is not hypothetical. On 30 Aug 2026 the roster held:
 *     Ryder Schilling  ryder@aisyndicate.com        owner
 *     Ryder Schilling  ryderschilling@gmail.com     sales rep   (his rep test login)
 * A task assigned to the second one was proven, in a browser, to be missing
 * from the first one's Work page while looking perfectly normal on Operations.
 * Two people called Chris at a growing agency is a Tuesday, so this had to stop
 * being a data accident and start being a rule.
 *
 * THE RULE: a name is shown alone only while it is unique in the list being
 * drawn. The moment it is not, every copy of it carries its email. Nobody who
 * has one Sam gets "Sam (sam@…)" pushed at them, and nobody who has two ever
 * sees a choice they cannot make.
 *
 * The list passed in is the list judged — a picker filtered to active members
 * asks about active members, which is what the person is actually choosing
 * from. Deactivating one of two clashing people correctly takes the email back
 * off the other.
 */

/* HOW MUCH OF THE EMAIL TO SHOW.
 *
 * The first version appended the whole address — "Ryder Schilling
 * (ryderschilling@gmail.com)" — which is unambiguous in a dropdown and useless
 * in a table cell, where it truncates to "Ryder Schilling (ry…" and the two
 * people look identical again. Half a fix is the dangerous kind: it LOOKS
 * disambiguated.
 *
 * So the label carries the shortest thing that actually tells them apart. Two
 * people on the same domain differ before the @, which is the common case
 * (ryder vs ryderschilling), so the local part is enough and it fits. Two
 * people whose local parts also match must differ by domain, and then the whole
 * address goes in. Nothing is ever shortened to something that still collides.
 */
function shortestTellApart(members) {
  const locals = members.map((m) => emailOf(m).split("@")[0]);
  const unique = new Set(locals.filter(Boolean)).size === locals.length && locals.every(Boolean);
  return (m) => (unique ? emailOf(m).split("@")[0] : emailOf(m));
}

/** Nobody's name, in the one shape the console says it. */
export const NOBODY = "Unassigned";

function nameOf(m) {
  return String(m?.full_name || "").trim();
}

function emailOf(m) {
  return String(m?.email || "").trim();
}

/** How many times each name appears, lowercased so "CJ" and "cj" collide too. */
function nameCounts(team) {
  const counts = new Map();
  for (const m of team || []) {
    const key = nameOf(m).toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** What to call this member, given everybody they are being shown beside.
 * Falls back to the email, then to a plain word — never to an empty label,
 * because a blank row in a picker looks like a picker that failed to load. */
export function personLabel(member, team) {
  const name = nameOf(member);
  const email = emailOf(member);
  if (!name) return email || "Someone on the team";
  const key = name.toLowerCase();
  const clashing = (team || []).filter((m) => nameOf(m).toLowerCase() === key);
  if (clashing.length < 2 || !email) return name;
  return `${name} (${shortestTellApart(clashing)(member)})`;
}

/** Every member as a { value, label } option, disambiguated as a set.
 * One pass over the roster rather than one per row. */
export function peopleOptions(team) {
  const counts = nameCounts(team);
  /* One shortener per clashing name, worked out once rather than per row —
   * every copy of a name has to be shortened the SAME way or the two labels
   * are not comparable. */
  const shorteners = new Map();
  for (const [key, n] of counts) {
    if (n < 2) continue;
    shorteners.set(key, shortestTellApart((team || []).filter((m) => nameOf(m).toLowerCase() === key)));
  }
  return (team || []).map((m) => {
    const name = nameOf(m);
    const email = emailOf(m);
    let label;
    if (!name) label = email || "Someone on the team";
    else if (shorteners.has(name.toLowerCase()) && email) {
      label = `${name} (${shorteners.get(name.toLowerCase())(m)})`;
    } else label = name;
    return { value: m.user_id, label };
  });
}

/** The label for one user_id, or null when nobody is assigned. Returning null
 * rather than a word lets each screen say its own thing for "nobody" — some
 * say "Unassigned", some draw an empty cell. */
export function labelForUser(userId, team) {
  if (!userId) return null;
  const m = (team || []).find((x) => x.user_id === userId);
  return m ? personLabel(m, team) : null;
}
