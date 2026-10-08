import { plantReference } from "./plant-reference.mjs";

const plantNetApiUrl = "https://my-api.plantnet.org/v2/identify";

export async function identifyPlant({
  imageBuffer,
  mimeType,
  apiKey = process.env.PLANTNET_API_KEY,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    const error = new Error("Pl@ntNet API anahtarı ayarlanmamış.");
    error.code = "missing_api_key";
    throw error;
  }

  const form = new FormData();
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  form.append("images", new Blob([imageBuffer], { type: mimeType }), `yaprak-fotografi.${extension}`);
  form.append("organs", "leaf");

  const url = new URL(`${plantNetApiUrl}/all`);
  url.searchParams.set("api-key", apiKey);

  let upstream;
  try {
    upstream = await fetchImpl(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      error.code = "timeout";
    } else {
      error.code = "connection";
      error.networkCode = getNetworkErrorCode(error);
    }
    throw error;
  }

  if (!upstream.ok) {
    const responseBody = typeof upstream.text === "function"
      ? await upstream.text().catch(() => "")
      : "";
    const error = new Error("Pl@ntNet API isteği başarısız oldu.");
    error.status = upstream.status;
    error.code = getUpstreamErrorCode(upstream.status, responseBody);
    error.upstreamMessage = extractUpstreamMessage(responseBody, apiKey);
    throw error;
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    const error = new Error("Pl@ntNet geçerli JSON yanıtı döndürmedi.");
    error.code = "invalid_response";
    throw error;
  }
  const matches = normalizePlantNetMatches(payload);
  if (matches.length === 0) {
    const error = new Error("Pl@ntNet yanıtında tanınabilir bir bitki eşleşmesi bulunamadı.");
    error.code = "no_match";
    throw error;
  }

  return matches;
}

function getNetworkErrorCode(error) {
  const causeCode = error.cause?.code;
  return typeof causeCode === "string" && /^[A-Z0-9_]{1,40}$/.test(causeCode) ? causeCode : "";
}

function getUpstreamErrorCode(status, responseBody = "") {
  if (status === 404 && /species not found/i.test(responseBody)) return "no_match";
  if (status === 400) return "invalid_request";
  if (status === 401 || status === 403) return "invalid_credentials";
  if (status === 404) return "project_unavailable";
  if (status === 413) return "image_too_large";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream_unavailable";
  return "upstream_error";
}

function extractUpstreamMessage(body, apiKey) {
  let message = body.trim();
  try {
    const parsed = JSON.parse(message);
    message = [parsed.message, parsed.error, parsed.detail]
      .find((value) => typeof value === "string" && value.trim()) || "";
  } catch {
    message = message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  return message
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/api-key=[^&\s"'<>]+/gi, "api-key=[REDACTED]")
    .slice(0, 300);
}

export function normalizePlantNetMatches(payload) {
  if (!payload || !Array.isArray(payload.results)) return [];

  const matches = [];
  const seen = new Set();
  for (const item of payload.results) {
    const species = item?.species;
    const scientificName = cleanTaxonName(species?.scientificNameWithoutAuthor || species?.scientificName);
    const score = item?.score;
    if (!scientificName || typeof score !== "number" || !Number.isFinite(score)) continue;

    const commonNames = findCropNames(scientificName);
    const plant = commonNames.length > 0
      ? formatCropName(commonNames)
      : scientificName;
    const key = `${scientificName.toLocaleLowerCase("en")}:${plant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      plant,
      scientificName,
      score: Math.round(Math.max(0, Math.min(1, score)) * 100),
    });
    if (matches.length === 3) break;
  }

  return matches;
}

function findCropNames(scientificName) {
  const normalized = normalizeScientificName(scientificName);
  return plantReference
    .filter(([, , referenceName]) => {
      const reference = normalizeScientificName(referenceName);
      return reference === normalized || (!reference.includes(" ") && normalized.startsWith(`${reference} `));
    })
    .map(([turkish, english]) => ({ turkish, english }));
}

function formatCropName(crops) {
  const turkish = [...new Set(crops.map(({ turkish }) => turkish))].join(" / ");
  const english = [...new Set(crops.map(({ english }) => english))].join(" / ");
  return `${turkish} (${english})`;
}

function normalizeScientificName(value) {
  return cleanTaxonName(value)
    .replace(/\s+(?:subsp\.?|ssp\.?|var\.?|f\.?)\s+.+$/i, "")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ");
}

function cleanTaxonName(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
