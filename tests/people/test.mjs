/* NAMING A TEAMMATE SO THE RIGHT ONE GETS THE WORK.
 *
 * The bug this pins was found in a browser on 30 Aug 2026, not in a review: the
 * roster held TWO members called "Ryder Schilling" (the owner, and his own
 * sales-rep test login). Every picker drew `full_name || email`, so both rows
 * read "Ryder Schilling" and nothing distinguished them. A task assigned to the
 * second one was proven missing from the first one's Work page while looking
 * completely normal on Operations. Work does not get much more lost than that.
 */
import { readFileSync } from "node:fs";
import { personLabel, peopleOptions, labelForUser } from "../../src/lib/people.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* The real roster as it stood on 30 Aug 2026. */
const ROSTER = [
  { user_id: "u-owner", full_name: "Ryder Schilling", email: "ryder@aisyndicate.com" },
  { user_id: "u-andrew", full_name: "Andrew Soncini", email: "andrew@aisyndicate.com" },
  { user_id: "u-cj", full_name: "CJ Britton", email: "cj@aisyndicate.com" },
  { user_id: "u-rep", full_name: "Ryder Schilling", email: "ryderschilling@gmail.com" },
];

console.log("\nTHE CLASH IS BROKEN APART");

const opts = peopleOptions(ROSTER);
const labels = opts.map((o) => o.label);
ok("no two people are drawn with the same label", new Set(labels).size === labels.length, labels.join(" | "));
eq("the owner carries the part of his address that differs", labels[0], "Ryder Schilling (ryder)");
eq("the rep carries his", labels[3], "Ryder Schilling (ryderschilling)");
eq("every option still points at the right user_id", opts.map((o) => o.value).join(","),
  "u-owner,u-andrew,u-cj,u-rep");

console.log("\nAND NOBODY ELSE IS MADE UGLY FOR IT");

eq("a unique name is left alone", labels[1], "Andrew Soncini");
eq("so is the other one", labels[2], "CJ Britton");
eq("a roster with no clash shows plain names",
  peopleOptions(ROSTER.slice(0, 3)).map((o) => o.label).join(" | "),
  "Ryder Schilling | Andrew Soncini | CJ Britton");

/* The list passed in is the list judged. Deactivating one of two clashing
 * people has to take the email back off the other, or the console keeps
 * apologising for a collision that no longer exists. */
eq("dropping the clashing member takes the email back off",
  personLabel(ROSTER[0], ROSTER.filter((m) => m.user_id !== "u-rep")), "Ryder Schilling");
eq("...and puts it back when they return", personLabel(ROSTER[0], ROSTER),
  "Ryder Schilling (ryder)");

console.log("\nCASE AND WHITESPACE ARE NOT A DIFFERENT PERSON");

const SLOPPY = [
  { user_id: "a", full_name: "cj britton", email: "cj@aisyndicate.com" },
  { user_id: "b", full_name: "  CJ Britton  ", email: "cjb@aisyndicate.com" },
];
const sloppy = peopleOptions(SLOPPY).map((o) => o.label);
ok("a lowercase copy of a name still counts as a clash",
  sloppy.every((l) => l.includes("(")), sloppy.join(" | "));

/* THE SHORTENING MUST NEVER PRODUCE A NEW COLLISION. Same local part on two
 * domains: shortening to "sam" twice would look disambiguated and not be. */
const SAME_LOCAL = [
  { user_id: "a", full_name: "Sam Reed", email: "sam@aisyndicate.com" },
  { user_id: "b", full_name: "Sam Reed", email: "sam@gmail.com" },
];
const both = peopleOptions(SAME_LOCAL).map((o) => o.label);
ok("identical local parts fall back to the WHOLE address",
  both[0] === "Sam Reed (sam@aisyndicate.com)" && both[1] === "Sam Reed (sam@gmail.com)", both.join(" | "));
ok("...and the two labels still differ", both[0] !== both[1]);

/* Three of them. Every copy has to be shortened the same way or the labels
 * are not comparable with each other. */
const THREE = [
  { user_id: "a", full_name: "Sam Reed", email: "sam@x.com" },
  { user_id: "b", full_name: "Sam Reed", email: "samr@x.com" },
  { user_id: "c", full_name: "Sam Reed", email: "sreed@x.com" },
];
const three = peopleOptions(THREE).map((o) => o.label);
ok("three people with one name all get told apart", new Set(three).size === 3, three.join(" | "));
ok("...and all three are shortened the same way", three.every((l) => !l.includes("@")), three.join(" | "));
ok("...and the padded one is trimmed, not drawn with its spaces",
  sloppy[1] === "CJ Britton (cjb)", sloppy[1]);

console.log("\nNOTHING EVER DRAWS AS A BLANK ROW");

eq("no name falls back to the email",
  personLabel({ user_id: "x", full_name: "", email: "nobody@x.com" }, []), "nobody@x.com");
eq("no name and no email still says something",
  personLabel({ user_id: "x", full_name: "", email: "" }, []), "Someone on the team");
eq("a null member does not throw", personLabel(null, ROSTER), "Someone on the team");
eq("an empty roster does not throw", peopleOptions([]).length, 0);
eq("an undefined roster does not throw", peopleOptions(undefined).length, 0);
ok("a name-only member (no email) is drawn by name even in a clash",
  peopleOptions([{ user_id: "a", full_name: "Sam", email: "" },
                 { user_id: "b", full_name: "Sam", email: "" }])
    .every((o) => o.label === "Sam"));

console.log("\nLOOKING SOMEBODY UP BY ID");

eq("finds the owner", labelForUser("u-owner", ROSTER), "Ryder Schilling (ryder)");
eq("finds the rep", labelForUser("u-rep", ROSTER), "Ryder Schilling (ryderschilling)");
eq("nobody assigned is null, not a word", labelForUser(null, ROSTER), null);
eq("an id nobody has is null, not a guess", labelForUser("u-ghost", ROSTER), null);

console.log("\nEVERY PICKER IN THE CONSOLE GOES THROUGH IT");

/* The structural half. Four files drew `full_name || email` into a person
 * picker; if any of them grows the old line back, this fails. */
const FILES = [
  "src/components/admin/Operations.jsx",
  "src/components/admin/opsTable.jsx",
  "src/components/admin/Inbox.jsx",
  "src/components/admin/SalesPage.jsx",
];
for (const f of FILES) {
  const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
  /* Only PICKERS and row labels — `member.full_name || member.email` is the
   * signed-in person naming themselves in an audit note, which is a different
   * job and is left alone deliberately. What must never come back is a label
   * built for somebody ELSE out of a team list. */
  ok(`${f} builds no <option> label by hand`,
    !/<option[^>]*>\{[a-z]+\.full_name \|\| [a-z]+\.email\}/.test(src));
  ok(`${f} builds no {value,label} person option by hand`,
    !/label: [a-z]+\.full_name \|\| [a-z]+\.email/.test(src));
  ok(`${f} looks nobody up by hand`,
    !/return m \? \([a-z]+\.full_name \|\| [a-z]+\.email\)/.test(src));
  ok(`${f} uses src/lib/people.js`, /from "\.\.\/\.\.\/lib\/people\.js"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
