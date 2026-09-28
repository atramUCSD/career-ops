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
