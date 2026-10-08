import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelResult } from "./analysis-parser.mjs";
import { plantReference } from "./plant-reference.mjs";
import { identifyPlant } from "./plantnet.mjs";

const app = express();
const port = Number(process.env.PORT) || 3001;
const model = process.env.NVIDIA_MODEL || "meta/llama-3.2-90b-vision-instruct";
const maxImageBytes = 10 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    referenceCrops: plantReference.length,
    plantNetConfigured: Boolean(process.env.PLANTNET_API_KEY),
    diseaseAssessmentConfigured: Boolean(process.env.NVIDIA_API_KEY),
  });
});

app.use(express.json({ limit: "14mb" }));

const capacitorOrigins = new Set(["capacitor://localhost", "http://localhost", "https://localhost"]);
app.use("/api", (request, response, next) => {
  const origin = request.headers.origin;
  if (origin && capacitorOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") return response.sendStatus(204);
  }
  next();
});

app.post("/api/analyze", async (request, response) => {
  const { imageDataUrl } = request.body ?? {};
  if (typeof imageDataUrl !== "string") {
    return response.status(400).json({ error: "Analiz edilecek görsel bulunamadı." });
  }

  const match = imageDataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !allowedMimeTypes.has(match[1])) {
    return response.status(400).json({ error: "Yalnızca JPG, PNG veya WEBP görselleri analiz edilebilir." });
  }

  const imageBuffer = Buffer.from(match[2], "base64");
  if (imageBuffer.length === 0 || imageBuffer.length > maxImageBytes) {
    return response.status(400).json({ error: "Görsel boş veya 10 MB sınırını aşıyor." });
  }

  try {
    const matches = await identifyPlant({ imageBuffer, mimeType: match[1] });
    const healthAssessment = await assessPlantHealth(imageDataUrl, matches[0]);
    const alternatives = matches.slice(1).map((plant) => ({
      name: plant.plant,
      evidence: `Pl@ntNet eşleşme skoru: ${plant.score}%.`,
    }));
    const result = {
      plant: matches[0].plant,
      scientificName: matches[0].scientificName,
      condition: healthAssessment?.condition ?? "Hastalık değerlendirmesi yapılamadı",
      confidence: matches[0].score,
      alternatives,
      description: healthAssessment?.description ??
        `Bitki türü Pl@ntNet ile eşleştirildi (${matches[0].scientificName}). Hastalık değerlendirmesi şu anda alınamadı; belirtiler sürerse yerel bir ziraat uzmanına danışın.`,
      steps: healthAssessment?.steps ?? [
        "Belirtilerin değişimini gözlemleyip not edin.",
        "Belirti artarsa yerel bir ziraat uzmanına danışın.",
      ],
      healthAssessmentAvailable: Boolean(healthAssessment),
    };

    return response.json({ result, identificationProvider: "Pl@ntNet" });
  } catch (error) {
    if (error.code === "missing_api_key") {
      return response.status(503).json({
        error: "Sunucuda PLANTNET_API_KEY ayarlanmamış. Render ortam değişkenlerine Pl@ntNet API anahtarını ekleyin.",
      });
    }
    if (error.code === "no_match") {
      return response.status(422).json({
        error: "Pl@ntNet fotoğrafta güvenilir bir bitki eşleşmesi bulamadı. Yaprağın tamamını net ve aydınlık gösteren başka bir fotoğraf deneyin.",
      });
    }
    if (error.status === 401 || error.status === 403) {
      console.error("Pl@ntNet API rejected the server credentials.", error.upstreamMessage || "");
      return response.status(502).json({
        error: "Pl@ntNet API anahtarı geçersiz veya proje erişim izni bulunmuyor.",
        providerDetails: error.upstreamMessage || undefined,
      });
    }
    if (error.code === "project_unavailable") {
      console.error("Pl@ntNet API does not provide the all-species project for this request.", error.upstreamMessage || "");
      return response.status(502).json({
        error: "Pl@ntNet tüm türler projesini bu istek için bulamadı. Pl@ntNet API anahtarınızın API erişimini kontrol edin.",
        providerDetails: error.upstreamMessage || undefined,
      });
    }
    if (error.code === "invalid_request") {
      console.error("Pl@ntNet API rejected the image request.");
      return response.status(422).json({
        error: "Pl@ntNet fotoğrafı kabul etmedi. Yaprağın tamamını net gösteren JPG, PNG veya WEBP bir fotoğraf deneyin.",
      });
    }
    if (error.code === "image_too_large") {
      console.error("Pl@ntNet API rejected the image size.");
      return response.status(413).json({
        error: "Pl@ntNet fotoğraf boyutunu kabul etmedi. Daha küçük bir görsel deneyin.",
      });
    }
    if (error.code === "rate_limit" || error.status === 429) {
      console.error("Pl@ntNet API rate limit reached.");
      return response.status(429).json({
        error: "Pl@ntNet kullanım sınırına ulaşıldı. Biraz sonra tekrar deneyin.",
      });
    }
    if (error.code === "upstream_unavailable") {
      console.error(`Pl@ntNet API returned HTTP ${error.status}.`);
      return response.status(502).json({
        error: "Pl@ntNet şu anda hizmet veremiyor. Biraz sonra tekrar deneyin.",
      });
    }
    if (error.code === "invalid_response") {
      console.error("Pl@ntNet API returned a non-JSON response.");
      return response.status(502).json({
        error: "Pl@ntNet geçerli bir yanıt vermedi. Lütfen daha sonra tekrar deneyin.",
      });
    }
    if (error.code === "timeout" || error.name === "TimeoutError" || error.name === "AbortError") {
      console.error("Pl@ntNet identification request timed out.");
      return response.status(504).json({
        error: "Pl@ntNet analizi zaman aşımına uğradı. Lütfen tekrar deneyin.",
      });
    }
    if (error.code === "connection") {
      console.error(`Cannot connect from API server to Pl@ntNet${error.networkCode ? ` (${error.networkCode})` : ""}.`);
      return response.status(502).json({
        error: "Uygulama sunucusu Pl@ntNet servisine erişemedi. Telefonunuzun interneti çalışsa bile sunucu tarafındaki bağlantı başarısız olabilir; biraz sonra tekrar deneyin.",
      });
    }
    console.error("Plant identification request failed:", error.message);
    return response.status(502).json({
      error: "Pl@ntNet bitki tanıma servisine bağlanılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
    });
  }
});

async function assessPlantHealth(imageDataUrl, plant) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;

  const prompt = `The plant identity has already been determined by Pl@ntNet as ${plant.plant} (${plant.scientificName}). Do not identify or rename the plant. Analyze only visible leaf health symptoms in the supplied image. If no disease is clearly supported, say that symptoms cannot be determined. Do not invent a pathogen or certainty. Write all user-facing text in natural Turkish. Give only low-risk observation suggestions; never recommend pesticides, medicines, dosages, or treatment chemicals.

Return only this JSON shape: {"plant":"${plant.plant}","scientificName":"${plant.scientificName}","condition":"visible symptom or Belirti belirlenemedi","confidence":null,"alternatives":[],"description":"one or two Turkish sentences grounded in visible evidence","steps":["short safe suggestion"]}`;

  try {
    const upstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 350,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "The plant identity is provided by Pl@ntNet and must not be changed. Assess only visible leaf symptoms. All user-facing text must be Turkish, cautious, and non-prescriptive. Return only the requested JSON object.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!upstream.ok) {
      console.error(`NVIDIA disease assessment failed (${upstream.status}).`);
      return null;
    }

    const payload = await upstream.json();
    const content = payload.choices?.[0]?.message?.content;
    const result = typeof content === "string" ? parseModelResult(content) : null;
    return result
      ? {
          condition: result.condition,
          description: result.description,
          steps: result.steps,
        }
      : null;
  } catch (error) {
    console.error("NVIDIA disease assessment request failed:", error.message);
    return null;
  }
}

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve(__dirname, "../dist")));
  app.get("*", (_request, response) => {
    response.sendFile(path.resolve(__dirname, "../dist/index.html"));
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Tarım Asistanı sunucusu 0.0.0.0:${port} adresinde çalışıyor.`);
});
