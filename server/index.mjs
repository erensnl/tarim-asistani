import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelResult } from "./analysis-parser.mjs";
import { formatPlantReference } from "./plant-reference.mjs";

const app = express();
const port = Number(process.env.PORT) || 3001;
const model = process.env.NVIDIA_MODEL || "meta/llama-3.2-90b-vision-instruct";
const maxImageBytes = 10 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
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
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      error: "NVIDIA API anahtarı ayarlanmamış. Proje klasöründe .env dosyası oluşturup NVIDIA_API_KEY değerini ekleyin.",
    });
  }

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

  const prompt = `Analyze the actual plant/leaf in the supplied image. Return only one valid JSON object, with no Markdown.

LANGUAGE: Every explanation, symptom, and care suggestion shown to the user MUST be written in natural Turkish. The plant name must be Turkish first and the common English name in parentheses. Never write the explanation or recommendations in English.

Identify the most likely plant, not only whether it is diseased. Compare the actual leaf shape, simple vs compound structure, leaflet count and arrangement, edge, veins, base, petiole, texture, and visible stem context. Do not identify a species from generic traits such as "green oval leaf." Do not let the reference list restrict you: if another species fits better, identify it and explain the visible evidence.

Only return other plant possibilities when there is real uncertainty AND the image contains a specific visible feature that supports each candidate. For each candidate, state that image feature as evidence. Do not add familiar plants as generic alternatives, do not repeat the same few alternatives for unrelated photos, and do not return a candidate based only on vague words like "oval leaf" or "green leaf." If no other species has a distinctive visible match, return an empty alternatives array. Alternatives must be selected from the reference list below.

Common cultivated plants and concise visual comparison reference:
${formatPlantReference()}

Put a Latin scientific name in scientificName only when reasonably supported by the image; otherwise use "Belirlenemedi". Do not invent a disease. confidence is a rough visual confidence score, not a calibrated probability; keep it at or below 55 when the species is ambiguous, only a partial leaf is visible, or the image is unclear. Use no pesticides, medicine, dosages, or treatment prescriptions. Give 2-3 short, low-risk observation/care suggestions in Turkish. Keep description concise (one or two sentences).

JSON schema: {"plant":"Türkçe yaygın ad (English common name)","scientificName":"kanıt varsa Latince ad, yoksa Belirlenemedi","condition":"görülen belirti veya Belirti belirlenemedi","confidence":0,"alternatives":[{"name":"Türkçe ad (English name)","evidence":"fotoğrafta görülen ayırt edici özellik"}],"description":"Türkçe, bir veya iki cümlelik ve görüntüdeki kanıta dayanan açıklama","steps":["Türkçe güvenli öneri"]}`;

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
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Follow all user instructions. All prose intended for the user must be Turkish. Never invent alternative plant identities; each alternative needs specific visible evidence from the image. Return only the requested JSON object.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: imageDataUrl },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`NVIDIA API error (${upstream.status}): ${errorBody.slice(0, 1000)}`);
      return response.status(upstream.status === 429 ? 429 : 502).json({
        error: upstream.status === 401 || upstream.status === 403
          ? "NVIDIA API anahtarı geçersiz veya bu modele erişim yetkisi yok."
          : upstream.status === 429
            ? "NVIDIA API kullanım sınırına ulaşıldı. Biraz sonra tekrar deneyin."
            : "NVIDIA analiz servisi şu anda yanıt veremiyor. Lütfen daha sonra tekrar deneyin.",
      });
    }

    const payload = await upstream.json();
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      console.error("NVIDIA API returned no text content.");
      return response.status(502).json({ error: "NVIDIA yanıtı okunamadı. Lütfen tekrar deneyin." });
    }

    const result = parseModelResult(content);
    if (!result) {
      console.error("NVIDIA API returned content that did not match the expected result format.");
      return response.status(502).json({ error: "Analiz yanıtı beklenen biçimde değildi. Lütfen tekrar deneyin." });
    }

    return response.json({ result, model });
  } catch (error) {
    console.error("NVIDIA analysis request failed:", error);
    return response.status(502).json({
      error: error.name === "TimeoutError" || error.name === "AbortError"
        ? "Analiz zaman aşımına uğradı. Lütfen tekrar deneyin."
        : "NVIDIA servisine bağlanılamadı. İnternet bağlantınızı kontrol edin.",
    });
  }
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve(__dirname, "../dist")));
  app.get("*", (_request, response) => {
    response.sendFile(path.resolve(__dirname, "../dist/index.html"));
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Tarım Asistanı sunucusu 0.0.0.0:${port} adresinde çalışıyor.`);
});
