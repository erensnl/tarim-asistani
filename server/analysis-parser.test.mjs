import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAlternatives, parseModelResult } from "./analysis-parser.mjs";
import { formatPlantReference, plantReference } from "./plant-reference.mjs";

test("parses NVIDIA's inline Turkish markdown response", () => {
  const response = [
    "**Türkçe Adı:** Akçaağaç yaprağı",
    "**Bilimsel Adı:** Belirlenemedi",
    "**Görünen Olası Belirti:** Yapraklar ve yaprak kenarları",
    "**Güvenilirlik:** 80",
    "**Açıklama:** Yaprak şekli ve kenar yapısı görünmektedir.",
    "**Güvenli Adımlar:** Yaprakları gözlemleyin. Belirtiler sürerse uzmana danışın.",
  ].join(" ");

  assert.deepEqual(parseModelResult(response), {
    plant: "Akçaağaç (Maple)",
    scientificName: "Belirlenemedi",
    condition: "Yapraklar ve yaprak kenarları",
    confidence: 80,
    alternatives: [],
    description: "Yaprak şekli ve kenar yapısı görünmektedir.",
    steps: ["Yaprakları gözlemleyin.", "Belirtiler sürerse uzmana danışın."],
  });
});

test("does not turn unsafe treatment advice into a suggested next step", () => {
  const response = [
    "**Türkçe Adı:** Domates",
    "**Görünen Olası Belirti:** Yaprak lekesi",
    "**Güvenli Adımlar:** Fungisit püskürtün. Bitkiyi gözlemleyin.",
  ].join(" ");

  const result = parseModelResult(response);
  assert.equal(result.plant, "Domates (Tomato)");
  assert.deepEqual(result.steps, [
    "Bitkiyi gözlemleyin.",
  ]);
});

test("cleans markdown and shows the Turkish maple name before its English name", () => {
  const result = parseModelResult([
    "**Türkçe Adı:** Maple (Ağaç) *",
    "**Bilimsel Adı:** Belirlenemedi *",
    "**Görünen Olası Belirti:** Yapraklar *",
    "**Güvenilirlik:** 80",
    "**Güvenli Adımlar:** Yaprakları gözlemleyin.",
  ].join(" "));

  assert.equal(result.plant, "Akçaağaç (Maple)");
  assert.equal(result.scientificName, "Belirlenemedi");
  assert.equal(result.condition, "Yapraklar");
  assert.equal(result.confidence, 80);
});

test("keeps the English name in parentheses when the model supplies Turkish first", () => {
  const result = parseModelResult(JSON.stringify({
    plant: "Domates (Tomato)",
    scientificName: "Solanum lycopersicum",
    condition: "Belirti belirlenemedi",
    confidence: 55,
    alternatives: ["Tütün (Tobacco)"],
    description: "Görselden bitki tanımlandı.",
    steps: ["Yaprağı gözlemleyin."],
  }));
  assert.equal(result.plant, "Domates (Tomato)");
  assert.deepEqual(result.alternatives, []);
});

test("normalizes a known English-only crop name to Turkish followed by English", () => {
  const result = parseModelResult(JSON.stringify({
    plant: "Hazelnut",
    scientificName: "Corylus avellana",
    condition: "Belirti belirlenemedi",
    confidence: 70,
    alternatives: [],
    description: "Yaprak geniş ve dişli kenarlıdır.",
    steps: ["Yaprağı gözlemleyin."],
  }));
  assert.equal(result.plant, "Fındık (Hazelnut)");
});

test("parses plain labels following a markdown section heading", () => {
  const response = "### Bitki Tanımı * Bitki Adı: Maple (Ağaç) * Bilimsel Adı: Belirlenemedi * Görünen Olası Belirti: Yaprak kenarları belirgin. * Güvenilirlik: 80 * Açıklama: Yaprak şekli görünüyor. * Güvenli Adımlar: Yaprakları gözlemleyin. Belirti artarsa uzmana danışın.";
  const result = parseModelResult(response);

  assert.equal(result.plant, "Akçaağaç (Maple)");
  assert.equal(result.scientificName, "Belirlenemedi");
  assert.equal(result.condition, "Yaprak kenarları belirgin.");
  assert.equal(result.confidence, 80);
  assert.equal(result.description, "Yaprak şekli görünüyor.");
  assert.deepEqual(result.steps, ["Yaprakları gözlemleyin.", "Belirti artarsa uzmana danışın."]);
});

test("provides hazelnut and a broad Turkish crop reference to the model", () => {
  const hazelnut = plantReference.find(([turkish]) => turkish === "Fındık");
  assert.deepEqual(hazelnut?.slice(0, 3), ["Fındık", "Hazelnut", "Corylus avellana"]);
  assert.match(formatPlantReference(), /Fındık \(Hazelnut\), Corylus avellana/);
  assert.ok(plantReference.length >= 35);
});

test("distinguishes beet leaves from leek leaves by vein and blade structure", () => {
  const beet = plantReference.find(([turkish]) => turkish === "Pancar");
  const leek = plantReference.find(([turkish]) => turkish === "Pırasa");
  assert.match(beet[3], /net-like veins/i);
  assert.match(beet[3], /not long, narrow/i);
  assert.match(leek[3], /parallel veins/i);
  assert.match(leek[3], /sheathing base/i);
  assert.match(formatPlantReference(), /Pancar \(Beetroot\)/);
  assert.match(formatPlantReference(), /Pırasa \(Leek\)/);
});

test("rejects a leek label paired with beet's scientific species", () => {
  const result = parseModelResult(JSON.stringify({
    plant: "Pırasa (Leek)",
    scientificName: "Beta vulgaris",
    condition: "Belirti belirlenemedi",
    confidence: 96,
    alternatives: [{ name: "Pancar (Beetroot)", evidence: "Yaprak geniş." }],
    description: "Yaprak geniş ve damarlı.",
    steps: ["Yaprağı gözlemleyin."],
  }));

  assert.equal(result.plant, "Bitki türü belirlenemedi");
  assert.equal(result.scientificName, "Belirlenemedi");
  assert.equal(result.confidence, null);
  assert.deepEqual(result.alternatives, []);
  assert.match(result.description, /birbiriyle uyuşmadığı için/);
});

test("does not falsely reject a beet label with its matching scientific species", () => {
  const result = parseModelResult(JSON.stringify({
    plant: "Pancar (Beetroot)",
    scientificName: "Beta vulgaris subsp. vulgaris",
    condition: "Belirti belirlenemedi",
    confidence: 72,
    alternatives: [],
    description: "Yapraktaki damarlanma ağı görülüyor.",
    steps: ["Yaprağı gözlemleyin."],
  }));

  assert.equal(result.plant, "Pancar (Beetroot)");
  assert.equal(result.confidence, 72);
});

test("only displays catalogued alternative plants with explicit Turkish image evidence", () => {
  assert.deepEqual(normalizeAlternatives([
    { name: "Tütün (Tobacco)", evidence: "Yaprak gövdeye tek tek bağlanıyor ve geniş." },
    { name: "Peanut", evidence: "Compound leaf with four leaflets." },
    { name: "Bilinmeyen tür", evidence: "Yaprağı oval." },
    { name: "Tütün (Tobacco)", evidence: "Yaprak gövdeye tek tek bağlanıyor ve geniş." },
  ]), [
    { name: "Tütün (Tobacco)", evidence: "Yaprak gövdeye tek tek bağlanıyor ve geniş." },
  ]);
});

test("replaces English explanation with a clear Turkish fallback", () => {
  const result = parseModelResult(JSON.stringify({
    plant: "Fındık (Hazelnut)",
    scientificName: "Corylus avellana",
    condition: "No disease detected",
    confidence: 40,
    alternatives: [],
    description: "The leaf is large and has a rough texture.",
    steps: ["Observe carefully.", "Take another photo."],
  }));

  assert.equal(result.condition, "Belirti belirlenemedi");
  assert.equal(result.description, "Yaprak özellikleri görselden tahmin edilmiştir; bu sonuç uzman değerlendirmesiyle doğrulanmalıdır.");
  assert.ok(result.steps.every((step) => !/\b(?:observe|photo|carefully)\b/i.test(step)));
});
