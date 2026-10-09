import test from "node:test";
import assert from "node:assert/strict";
import { getMongoConnectionSettings } from "./database.mjs";

const atlasTemplate =
  "mongodb+srv://<db_username>:<db_password>@cluster.example.net/tarim?retryWrites=true&w=majority";

test("uses Atlas username and password environment variables with a connection-string template", () => {
  const settings = getMongoConnectionSettings({
    MONGODB_URI: atlasTemplate,
    MONGODB_USERNAME: "farm@user",
    MONGODB_PASSWORD: "p@ss:/word",
  });

  assert.equal(
    settings.uri,
    "mongodb+srv://farm%40user:p%40ss%3A%2Fword@cluster.example.net/tarim?retryWrites=true&w=majority",
  );
  assert.equal(settings.options.serverSelectionTimeoutMS, 8000);
});

test("preserves a complete connection URI when separate credentials are not set", () => {
  const uri = "mongodb+srv://user:password@cluster.example.net/tarim";
  assert.equal(getMongoConnectionSettings({ MONGODB_URI: uri }).uri, uri);
});

test("requires both separate MongoDB credentials", () => {
  assert.throws(
    () => getMongoConnectionSettings({ MONGODB_URI: atlasTemplate, MONGODB_USERNAME: "farm-user" }),
    { code: "database_credentials_incomplete" },
  );
});

test("requires a MongoDB URI", () => {
  assert.throws(
    () => getMongoConnectionSettings({ MONGODB_USERNAME: "farm-user", MONGODB_PASSWORD: "secret" }),
    { code: "database_not_configured" },
  );
});

test("rejects a non-MongoDB URI when separate credentials are supplied", () => {
  assert.throws(
    () => getMongoConnectionSettings({
      MONGODB_URI: "https://cluster.example.net",
      MONGODB_USERNAME: "farm-user",
      MONGODB_PASSWORD: "secret",
    }),
    { code: "database_invalid_uri" },
  );
});
