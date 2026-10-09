import test from "node:test";
import assert from "node:assert/strict";
import {
  getSessionCookieOptions,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "./auth.mjs";

test("stores passwords as salted scrypt hashes and verifies them", async () => {
  const password = "uzun-ve-guvenli-sifre";
  const firstHash = await hashPassword(password);
  const secondHash = await hashPassword(password);

  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword(password, firstHash), true);
  assert.equal(await verifyPassword("yanlis-sifre", firstHash), false);
  assert.equal(await verifyPassword(password, "bozuk-hash"), false);
});

test("hashes session tokens before database storage", () => {
  assert.equal(hashSessionToken("opaque-token").length, 64);
  assert.equal(hashSessionToken("opaque-token"), hashSessionToken("opaque-token"));
  assert.notEqual(hashSessionToken("opaque-token"), "opaque-token");
});

test("uses secure cross-origin session cookies in production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.deepEqual(getSessionCookieOptions(), {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 2_592_000_000,
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
