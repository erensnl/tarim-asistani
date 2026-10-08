import assert from "node:assert/strict";
import test from "node:test";
import { identifyPlant, normalizePlantNetMatches } from "./plantnet.mjs";

const beetResponse = {
  results: [
    {
      score: 0.87,
      species: {
        scientificNameWithoutAuthor: "Beta vulgaris",
        scientificName: "Beta vulgaris L.",
      },
    },
    {
      score: 0.31,
      species: {
        scientificNameWithoutAuthor: "Allium ampeloprasum",
      },
    },
  ],
};

test("normalizes PlantNet results and does not confuse beet with leek", () => {
  const matches = normalizePlantNetMatches(beetResponse);

  assert.deepEqual(matches, [
    {
      plant: "Pancar / Pazı (Beetroot / Swiss chard)",
      scientificName: "Beta vulgaris",
      score: 87,
    },
    {
      plant: "Pırasa (Leek)",
      scientificName: "Allium ampeloprasum",
      score: 31,
    },
  ]);
});

test("filters invalid matches and caps the displayed alternatives", () => {
  const matches = normalizePlantNetMatches({
    results: [
      { score: Number.NaN, species: { scientificNameWithoutAuthor: "Beta vulgaris" } },
      { score: 0.9, species: { scientificNameWithoutAuthor: "Beta vulgaris" } },
      { score: 0.8, species: { scientificNameWithoutAuthor: "Beta vulgaris" } },
      { score: 0.7, species: { scientificNameWithoutAuthor: "Allium ampeloprasum" } },
      { score: 0.6, species: { scientificNameWithoutAuthor: "Zea mays" } },
      { score: 0.5, species: { scientificNameWithoutAuthor: "Corylus avellana" } },
    ],
  });

  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(({ score }) => score), [90, 70, 60]);
});

test("sends the image to PlantNet as a leaf and keeps its API key server-side", async () => {
  let requestedUrl;
  let requestedForm;
  const matches = await identifyPlant({
    imageBuffer: Buffer.from("sample image"),
    mimeType: "image/jpeg",
    apiKey: "test-secret",
    project: "all",
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedForm = options.body;
      assert.equal(options.method, "POST");
      return { ok: true, json: async () => beetResponse };
    },
  });

  assert.equal(requestedUrl.origin, "https://my-api.plantnet.org");
  assert.equal(requestedUrl.pathname, "/v2/identify/all");
  assert.equal(requestedUrl.searchParams.get("api-key"), "test-secret");
  assert.equal(requestedForm.get("organs"), "leaf");
  assert.equal(requestedForm.getAll("images").length, 1);
  assert.match(requestedForm.get("images").type, /image\/jpeg/);
  assert.equal(matches[0].plant, "Pancar / Pazı (Beetroot / Swiss chard)");
});

test("falls back to DNS-over-HTTPS and preserves the TLS hostname after system DNS fails", async () => {
  let resolvedHostname;
  let request;
  const matches = await identifyPlant({
    imageBuffer: Buffer.from("sample image"),
    mimeType: "image/jpeg",
    apiKey: "test-secret",
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("lookup EAI_AGAIN"), { code: "EAI_AGAIN" }),
      });
    },
    resolveAddress: async (hostname) => {
      resolvedHostname = hostname;
      return "193.51.117.162";
    },
    requestImpl: async (options) => {
      request = options;
      assert.equal(await options.resolveAddress(), "193.51.117.162");
      return { ok: true, status: 200, json: async () => beetResponse };
    },
  });

  assert.equal(resolvedHostname, "my-api.plantnet.org");
  assert.equal(request.url.hostname, "my-api.plantnet.org");
  assert.equal(request.url.searchParams.get("api-key"), "test-secret");
  assert.equal(matches[0].plant, "Pancar / Pazı (Beetroot / Swiss chard)");
});

test("resolves the PlantNet hostname using Google's DNS-over-HTTPS response", async () => {
  let requestedUrl;
  await identifyPlant({
    imageBuffer: Buffer.from("sample image"),
    mimeType: "image/jpeg",
    apiKey: "test-secret",
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      if (requestedUrl.hostname === "dns.google") {
        return {
          ok: true,
          json: async () => ({
            Answer: [
              { type: 5, data: "senonches.cirad.fr." },
              { type: 1, data: "193.51.117.162" },
            ],
          }),
        };
      }
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("lookup EAI_AGAIN"), { code: "EAI_AGAIN" }),
      });
    },
    requestImpl: async ({ resolveAddress }) => {
      assert.equal(await resolveAddress(), "193.51.117.162");
      return { ok: true, status: 200, json: async () => beetResponse };
    },
  });

  assert.equal(requestedUrl.hostname, "dns.google");
  assert.equal(requestedUrl.searchParams.get("name"), "my-api.plantnet.org");
  assert.equal(requestedUrl.searchParams.get("type"), "A");
});

test("reports missing API credentials without making an upstream request", async () => {
  await assert.rejects(
    identifyPlant({
      imageBuffer: Buffer.from("sample image"),
      mimeType: "image/jpeg",
      apiKey: "",
      fetchImpl: async () => {
        assert.fail("PlantNet should not be called without an API key");
      },
    }),
    { code: "missing_api_key" },
  );
});

test("reports API authorization failures without exposing response content", async () => {
  await assert.rejects(
    identifyPlant({
      imageBuffer: Buffer.from("sample image"),
      mimeType: "image/jpeg",
      apiKey: "test-secret",
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    { status: 401 },
  );
});

test("classifies upstream project, quota, and server failures", async () => {
  for (const [status, expectedCode] of [
    [404, "project_unavailable"],
    [429, "rate_limit"],
    [503, "upstream_unavailable"],
  ]) {
    await assert.rejects(
      identifyPlant({
        imageBuffer: Buffer.from("sample image"),
        mimeType: "image/jpeg",
        apiKey: "test-secret",
        fetchImpl: async () => ({ ok: false, status }),
      }),
      { status, code: expectedCode },
    );
  }
});

test("extracts upstream error details and redacts API credentials", async () => {
  await assert.rejects(
    identifyPlant({
      imageBuffer: Buffer.from("sample image"),
      mimeType: "image/jpeg",
      apiKey: "test-secret",
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          message: "Unknown project for api-key=test-secret",
        }),
      }),
    }),
    (error) => {
      assert.equal(error.code, "project_unavailable");
      assert.equal(error.upstreamMessage, "Unknown project for api-key=[REDACTED]");
      return true;
    },
  );
});

test("treats Pl@ntNet's Species not found 404 as an unmatched image, not a network failure", async () => {
  await assert.rejects(
    identifyPlant({
      imageBuffer: Buffer.from("sample image"),
      mimeType: "image/jpeg",
      apiKey: "test-secret",
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Species not found" }),
      }),
    }),
    (error) => {
      assert.equal(error.code, "no_match");
      assert.equal(error.upstreamMessage, "Species not found");
      return true;
    },
  );
});

test("reports malformed PlantNet responses without hiding them as a network error", async () => {
  await assert.rejects(
    identifyPlant({
      imageBuffer: Buffer.from("sample image"),
      mimeType: "image/jpeg",
      apiKey: "test-secret",
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("invalid JSON");
        },
      }),
    }),
    { code: "invalid_response" },
  );
});
