import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import https from "node:https";
import { plantReference } from "./plant-reference.mjs";

const plantNetApiUrl = "https://my-api.plantnet.org/v2/identify";

export async function identifyPlant({
  imageBuffer,
  mimeType,
  apiKey = process.env.PLANTNET_API_KEY,
  fetchImpl = fetch,
  resolveAddress = resolveHostnameWithDoh,
  requestImpl = postPlantNetToResolvedAddress,
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
    if (isDnsResolutionError(error)) {
      try {
        upstream = await requestImpl({
          url,
          imageBuffer,
          mimeType,
          resolveAddress: () => resolveAddress(url.hostname, fetchImpl),
        });
      } catch (fallbackError) {
        fallbackError.code ??= "connection";
        fallbackError.networkCode ||= getNetworkErrorCode(error);
        throw fallbackError;
      }
    } else {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        error.code = "timeout";
      } else {
        error.code = "connection";
        error.networkCode = getNetworkErrorCode(error);
      }
      throw error;
    }
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
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const causeCode = current.code;
    if (typeof causeCode === "string" && /^[A-Z0-9_]{1,40}$/.test(causeCode)) return causeCode;
    current = current.cause;
  }
  return "";
}

function isDnsResolutionError(error) {
  return ["EAI_AGAIN", "ENOTFOUND", "EAI_FAIL", "EAI_NODATA"]
    .includes(getNetworkErrorCode(error));
}

async function resolveHostnameWithDoh(hostname, fetchImpl) {
  const resolverUrl = new URL("https://dns.google/resolve");
  resolverUrl.searchParams.set("name", hostname);
  resolverUrl.searchParams.set("type", "A");

  const response = await fetchImpl(resolverUrl, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`DNS-over-HTTPS resolver returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const address = payload.Answer?.find((answer) =>
    answer.type === 1 && typeof answer.data === "string" && isIPv4(answer.data),
  )?.data;
  if (!address) throw new Error(`No IPv4 DNS answer was returned for ${hostname}.`);
  return address;
}

async function postPlantNetToResolvedAddress({ url, imageBuffer, mimeType, resolveAddress }) {
  const address = await resolveAddress();
  const boundary = `----TarimAsistani-${randomUUID()}`;
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="organs"\r\n\r\nleaf\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="yaprak-fotografi.${extension}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: url.hostname,
      servername: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address, family: 4 }]);
        } else {
          callback(null, address, 4);
        }
      },
      timeout: 90_000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode || 502;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => responseBody,
          json: async () => JSON.parse(responseBody),
        });
      });
    });

    request.on("timeout", () => request.destroy(Object.assign(new Error("Pl@ntNet request timed out."), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    request.end(body);
  });
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
