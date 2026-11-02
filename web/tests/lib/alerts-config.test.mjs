import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsPatch } from "../../src/lib/alerts-config.mjs";

test("the digest editor writes only the settings it names, normalized", () => {
  assert.deepEqual(alertsPatch({ to: " a@example.com,b@example.org ", min_match: 0, max_rows: 100, enabled: false }), {
    patch: { to: "a@example.com, b@example.org", min_match: 0, max_rows: 100, enabled: false },
  });
  assert.deepEqual(alertsPatch({ to: "" }), { patch: { to: "" } });
  assert.deepEqual(alertsPatch({ artifact_url: "https://example.com" }), { error: "nothing to write" });
  assert.deepEqual(alertsPatch(null), { error: "config must be an object" });
});

test("a recipient can never carry a second header, and numbers stay in range", () => {
  assert.match(alertsPatch({ to: "a@example.com\r\nBcc: x@example.com" }).error, /one line/);
  assert.match(alertsPatch({ to: "a@example.com, not an address" }).error, /not an email address/);
  assert.match(alertsPatch({ to: "Pat <a@example.com>" }).error, /not an email address/);
  assert.match(alertsPatch({ min_match: 101 }).error, /0 to 100/);
  assert.match(alertsPatch({ max_rows: 0 }).error, /1 to 100/);
  assert.match(alertsPatch({ min_match: 4.5 }).error, /whole number/);
  assert.match(alertsPatch({ quiet_if_empty: "yes" }).error, /true or false/);
});

test("the calendar block is patched field by field, normalized", () => {
  assert.deepEqual(
    alertsPatch({
      calendar: {
        enabled: true,
        min_match: 70,
        minutes: 45,
        companies: [" Anduril ", "", "Anduril", "Figma"],
        exclude_hosts: ["LinkedIn.com", " indeed.com "],
        at: "7:30",
        time_zone: "America/New_York",
        calendar_id: " primary ",
      },
    }),
    {
      patch: {
        calendar: {
          enabled: true,
          min_match: 70,
          minutes: 45,
          companies: ["Anduril", "Figma"],
          exclude_hosts: ["linkedin.com", "indeed.com"],
          at: "7:30",
          time_zone: "America/New_York",
          calendar_id: "primary",
        },
      },
    },
  );
  // Left out means the file keeps its value; an empty list clears the constraint.
  assert.deepEqual(alertsPatch({ calendar: { keywords: [] } }), { patch: { calendar: { keywords: [] } } });
  assert.deepEqual(alertsPatch({ calendar: {} }), { error: "calendar has nothing to write" });
});

test("the calendar block refuses what calendar-alert.mjs would fail on", () => {
  assert.match(alertsPatch({ calendar: [] }).error, /must be an object/);
  assert.match(alertsPatch({ calendar: { at: "24:00" } }).error, /24-hour time/);
  assert.match(alertsPatch({ calendar: { at: "9pm" } }).error, /24-hour time/);
  assert.match(alertsPatch({ calendar: { time_zone: "Mars/Olympus" } }).error, /not a time zone/);
  assert.match(alertsPatch({ calendar: { minutes: 0 } }).error, /5 to 240/);
  assert.match(alertsPatch({ calendar: { min_match: -1 } }).error, /0 to 100/);
  assert.match(alertsPatch({ calendar: { enabled: "true" } }).error, /true or false/);
  assert.match(alertsPatch({ calendar: { keywords: "design" } }).error, /a list/);
  assert.match(alertsPatch({ calendar: { locations: ["San Diego\nX"] } }).error, /one line/);
  assert.match(alertsPatch({ calendar: { exclude_hosts: ["https://linkedin.com"] } }).error, /not a host name/);
  assert.match(alertsPatch({ calendar: { calendar_id: "" } }).error, /calendar_id/);
});

test("every calendar patch it accepts, calendarConfig accepts too", async () => {
  const { calendarConfig } = await import("../../../calendar-alert.mjs");
  for (const at of ["0:00", "07:05", "21:00", "23:59"]) {
    const { patch } = alertsPatch({ calendar: { at, time_zone: "Europe/Berlin" } });
    assert.doesNotThrow(() => calendarConfig({ calendar: patch.calendar }), at);
  }
  for (const at of ["24:00", "12:60", "7", "07:5"]) {
    assert.ok(alertsPatch({ calendar: { at } }).error, at);
    assert.throws(() => calendarConfig({ calendar: { at } }), undefined, at);
  }
});
