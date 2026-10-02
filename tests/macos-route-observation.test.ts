import assert from "node:assert/strict";
import test from "node:test";
import { parseIPv4Routes } from "../src/platform/macos";

test("network observation retains public, benchmark and static host routes", () => {
  const rows = [
    "default 10.0.0.1 UGScg en0",
    "1/8 10.0.0.2 UGS utun8",
    "198.18.2/24 link#1 USc lo0",
    "203.0.113.9 10.0.0.2 UGHS utun8",
  ];
  assert.deepEqual(
    parseIPv4Routes(
      [
        "Routing tables",
        "Internet:",
        "Destination Gateway Flags Netif Expire",
        ...rows,
      ].join("\n"),
    ),
    rows,
  );
});

test("transient neighbour rows cannot hide a later configured route", () => {
  const neighbours = Array.from(
    { length: 100 },
    (_, i) => `10.0.0.${i + 1} aa:bb:cc:dd:ee:ff UHLWIir en0 1190`,
  );
  const staticRoute = "198.18.2/24 link#1 USc lo0";
  assert.deepEqual(
    parseIPv4Routes(
      [...neighbours, "203.0.113.10 10.0.0.1 UGHW en0", staticRoute].join("\n"),
    ),
    [staticRoute],
  );
});
