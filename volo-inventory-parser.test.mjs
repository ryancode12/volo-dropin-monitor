import test from "node:test";
import assert from "node:assert/strict";
import { parseVoloGameInventory } from "./volo-inventory-parser.mjs";

test("mixed current Volo team slots leave an unrestricted spot", () => {
  const text =
    "Only 2 spots left Choose a spot Who needs a player Nutmeg Tea 2 spots · 1 women & non-binary";

  assert.deepEqual(parseVoloGameInventory(text), {
    total: 2,
    men: null,
    anyGender: null,
    openGender: null,
    womenOnly: 1,
    eligible: 1,
    source: "team-slot-reservations",
  });
});

test("fully reserved current Volo team slots are not eligible", () => {
  const text =
    "Only 2 spots left Choose a spot Who needs a player The Extra Pass 2 spots · 2 women & non-binary";

  assert.equal(parseVoloGameInventory(text).eligible, 0);
});

test("legacy labeled inventory still works", () => {
  const text = "Total Spot(s) Available 2 Women only 1 Any gender 1";
  const parsed = parseVoloGameInventory(text);

  assert.equal(parsed.total, 2);
  assert.equal(parsed.womenOnly, 1);
  assert.equal(parsed.anyGender, 1);
  assert.equal(parsed.eligible, 1);
  assert.equal(parsed.source, "labeled-buckets");
});
