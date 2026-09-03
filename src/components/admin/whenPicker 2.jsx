import { useEffect, useMemo, useRef, useState } from "react";
import { TextInput, Select } from "./shared.jsx";
import { clockLabel, timeSlots, splitWhen, joinWhen } from "../../../lib/when.js";

/* A DATE AND A TIME, WITH AM/PM AS SOMETHING YOU PICK — 2 Sep 2026.
 *
 * The rules, and why this exists at all, are in lib/when.js. This is the two
 * controls: a date input, which has no AM/PM to forget, and a list of times
 * whose every option says AM or PM in words.
 *
 * IT HOLDS THE TWO HALVES ITSELF, AND THAT IS NOT AN OPTIMISATION.
 *
 * The first version derived both halves from `value` on every render. `value`
 * is null until BOTH are answered — which is the entire point of it — so the
 * moment somebody picked a date and then opened the time list, the component
 * re-read `null`, decided the date was empty, and emitted a time with no date.
 * The date they had just chosen vanished, and the form said "pick a date".
 *
 * That is the same shape as the bug this component was written to kill, one
 * level down, and reading the file would not have found it: it was found by
 * filling the form in a browser and watching the answer disappear.
 *
 * So the halves live here. `value` is adopted when the CALLER changes it to
 * something complete — opening a record, resetting a form — and never used to
 * second-guess a half-finished answer somebody is in the middle of giving.
 *
 * A TIME ALREADY ON THE RECORD IS KEPT even when it is not on the half-hour —
 * an imported meeting at 2:07 PM is offered as it stands, marked. Opening a box
 * must never change the thing it was opened to show.
 */
export default function WhenPicker({ value, onChange, minDate = null, maxDate = null, disabled = false }) {
  const [half, setHalf] = useState(() => splitWhen(value));
  const lastValue = useRef(value);

  /* Adopt what the CALLER hands us, only when the caller is the one who changed
   * it. Comparing against the last value we saw — rather than against our own
   * halves — is what stops this fighting the person typing. */
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    setHalf(splitWhen(value));
  }, [value]);

  const options = useMemo(() => {
    const grid = timeSlots();
    const list = grid.includes(half.minutes) || half.minutes === null
      ? [...grid]
      : [...grid, half.minutes].sort((a, b) => a - b);
    return list.map((m) => [String(m), grid.includes(m) ? clockLabel(m) : `${clockLabel(m)} (as saved)`]);
  }, [half.minutes]);

  const emit = (date, minutes) => {
    setHalf({ date, minutes });
    const iso = joinWhen(date, minutes);
    lastValue.current = iso || "";
    onChange(iso, { date, minutes });
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <TextInput
        type="date"
        value={half.date}
        disabled={disabled}
        min={minDate || undefined}
        max={maxDate || undefined}
        onChange={(e) => emit(e.target.value, half.minutes)}
        style={{ flex: "1 1 150px", minWidth: 0 }}
        aria-label="Date"
      />
      <Select
        value={half.minutes === null ? "" : String(half.minutes)}
        disabled={disabled}
        onChange={(e) => emit(half.date, e.target.value === "" ? null : Number(e.target.value))}
        options={[["", "— pick a time —"], ...options]}
        style={{ flex: "1 1 150px", minWidth: 0 }}
        aria-label="Time"
      />
    </div>
  );
}
