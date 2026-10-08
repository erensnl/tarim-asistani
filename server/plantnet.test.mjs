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
