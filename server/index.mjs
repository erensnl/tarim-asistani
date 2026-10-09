import "dotenv/config";
import express from "express";
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelResult } from "./analysis-parser.mjs";
import { plantReference } from "./plant-reference.mjs";
import { identifyPlant } from "./plantnet.mjs";
import { getDatabase } from "./database.mjs";
import {
  clearSessionCookie,
  createSession,
  databaseErrorResponse,
  deleteCurrentSession,
  getCurrentSession,
  hashPassword,
  recordAuditEvent,
  requireAuthentication,
  verifyPassword,
} from "./auth.mjs";

const app = express();
const port = Number(process.env.PORT) || 3001;
const model = process.env.NVIDIA_MODEL || "meta/llama-3.2-90b-vision-instruct";
const maxImageBytes = 10 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    referenceCrops: plantReference.length,
    plantNetConfigured: Boolean(process.env.PLANTNET_API_KEY),
    diseaseAssessmentConfigured: Boolean(process.env.NVIDIA_API_KEY),
    aiAssistantConfigured: Boolean(process.env.NVIDIA_API_KEY),
    databaseConfigured: Boolean(process.env.MONGODB_URI),
  });
});

app.use(express.json({ limit: "14mb" }));

const capacitorOrigins = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && (capacitorOrigins.has(origin) || process.env.NODE_ENV !== "production")) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-App-Platform");
    if (request.method === "OPTIONS") return response.sendStatus(204);
  }
  next();
});

app.use((request, _response, next) => {
  request.cookies = Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]),
  );
  next();
});

app.post("/api/auth/register", async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = request.body?.password;
  if (name.length < 2 || name.length > 60) {
    return response.status(400).json({ error: "Ad soyad 2-60 karakter arasında olmalıdır." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return response.status(400).json({ error: "Geçerli bir e-posta adresi girin." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return response.status(400).json({ error: "Şifreniz 8-128 karakter arasında olmalıdır." });
  }

  try {
    const database = await getDatabase();
    const user = {
      name,
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
    };
    const created = await database.collection("users").insertOne(user);
    user._id = created.insertedId;
    await recordAuditEvent(request, { type: "register", email, userId: user._id });
    const sessionToken = await createSession(request, response, user);
    return response.status(201).json({
      user: { id: user._id.toString(), name: user.name, email: user.email },
      sessionToken: request.get("x-app-platform") === "capacitor" ? sessionToken : undefined,
    });
  } catch (error) {
    if (error.code === 11000) {
      return response.status(409).json({ error: "Bu e-posta adresiyle kayıtlı bir hesap zaten var." });
    }
    return databaseErrorResponse(error, response);
  }
});

app.post("/api/auth/login", async (request, response) => {
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = request.body?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== "string") {
    return response.status(400).json({ error: "E-posta adresi ve şifrenizi kontrol edin." });
  }

  try {
    const database = await getDatabase();
    const user = await database.collection("users").findOne({ email });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      await recordAuditEvent(request, { type: "login_failed", email, userId: user?._id ?? null });
      return response.status(401).json({ error: "E-posta adresi veya şifre hatalı." });
    }
    await recordAuditEvent(request, { type: "login", email, userId: user._id });
    const sessionToken = await createSession(request, response, user);
    return response.json({
      user: { id: user._id.toString(), name: user.name, email: user.email },
      sessionToken: request.get("x-app-platform") === "capacitor" ? sessionToken : undefined,
    });
  } catch (error) {
    return databaseErrorResponse(error, response);
  }
});

app.get("/api/auth/me", requireAuthentication, (request, response) => {
  const { id, name, email } = request.user;
  return response.json({ user: { id, name, email } });
});

app.post("/api/auth/logout", async (request, response) => {
  try {
    const session = await deleteCurrentSession(request);
    if (session) {
      await recordAuditEvent(request, {
        type: "logout",
        email: session.email,
        userId: session.userId,
      });
    }
    clearSessionCookie(response);
    return response.json({ ok: true });
  } catch (error) {
    return databaseErrorResponse(error, response);
  }
});

app.get("/api/conversations", requireAuthentication, async (request, response) => {
  try {
    const database = await getDatabase();
    const conversations = await database.collection("conversations")
      .find({ userId: request.user.databaseId, type: "advisor" })
      .sort({ updatedAt: -1 })
      .limit(20)
      .toArray();
    return response.json({
      conversations: conversations.map(({ _id, messages, updatedAt }) => ({
        id: _id.toString(),
        messages,
        updatedAt,
      })),
    });
  } catch (error) {
    return databaseErrorResponse(error, response);
  }
});

app.post("/api/assistant", requireAuthentication, async (request, response) => {
  const prompt = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  const requestedId = request.body?.conversationId;
  if (!prompt || prompt.length > 4000) {
    return response.status(400).json({ error: "Mesajınız 1-4000 karakter arasında olmalıdır." });
  }
  if (requestedId !== undefined && !ObjectId.isValid(requestedId)) {
    return response.status(400).json({ error: "Konuşma kimliği geçersiz." });
  }

  const database = await getDatabase().catch((error) => {
    databaseErrorResponse(error, response);
    return null;
  });
  if (!database) return;

  const collection = database.collection("conversations");
  const now = new Date();
  const conversationId = requestedId ? new ObjectId(requestedId) : new ObjectId();
  const userMessage = { role: "user", content: prompt, createdAt: now };
  let conversation;
  let previousMessages = [];
  try {
    conversation = requestedId
      ? await collection.findOne({ _id: conversationId, userId: request.user.databaseId, type: "advisor" })
      : null;
    if (requestedId && !conversation) {
      return response.status(404).json({ error: "Bu konuşma bulunamadı." });
    }
    previousMessages = conversation?.messages || [];
    if (conversation) {
      await collection.updateOne(
        { _id: conversationId, userId: request.user.databaseId },
        { $push: { messages: userMessage }, $set: { updatedAt: now } },
      );
    } else {
      conversation = {
        _id: conversationId,
        userId: request.user.databaseId,
        type: "advisor",
        messages: [userMessage],
        createdAt: now,
        updatedAt: now,
      };
      await collection.insertOne(conversation);
    }
  } catch (error) {
    return databaseErrorResponse(error, response);
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      error: "Fikir danışma için sunucuda NVIDIA_API_KEY yapılandırılmalıdır. Mesajınız konuşma geçmişinize kaydedildi.",
      conversationId: conversationId.toString(),
    });
  }

  try {
    const history = [...previousMessages, userMessage]
      .slice(-12)
      .map(({ role, content }) => ({ role, content }));
    const upstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 650,
        messages: [
          {
            role: "system",
            content: "Tarım Asistanı için Türkçe konuşan, dikkatli bir tarım danışmanısın. Fikir geliştirme, ekim planı ve genel bakım hakkında anlaşılır öneriler ver. Bilmediğin koşulları kesinmiş gibi sunma; yerel iklim/toprak bilgisini sor. Bitki hastalıklarını kesin teşhis etme ve pestisit, ilaç, doz veya kimyasal uygulama önermeden güvenli gözlem önerileri sun.",
          },
          ...history,
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!upstream.ok) {
      console.error(`AI advisor request failed (${upstream.status}).`);
      return response.status(502).json({
        error: "AI danışma servisi şu anda yanıt vermiyor. Mesajınız konuşma geçmişinize kaydedildi.",
        conversationId: conversationId.toString(),
      });
    }
    const payload = await upstream.json();
    const answer = payload.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      return response.status(502).json({ error: "AI danışma servisi boş yanıt verdi. Lütfen tekrar deneyin.", conversationId: conversationId.toString() });
    }
    const assistantMessage = { role: "assistant", content: answer.trim(), createdAt: new Date() };
    await collection.updateOne(
      { _id: conversationId, userId: request.user.databaseId },
      { $push: { messages: assistantMessage }, $set: { updatedAt: assistantMessage.createdAt } },
    );
    return response.json({ conversationId: conversationId.toString(), message: assistantMessage });
  } catch (error) {
    console.error("AI advisor request failed:", error.message);
    return response.status(502).json({
      error: "AI danışma isteği tamamlanamadı. Biraz sonra tekrar deneyin.",
      conversationId: conversationId.toString(),
    });
  }
});

app.post("/api/analyze", requireAuthentication, async (request, response) => {
  const { imageDataUrl } = request.body ?? {};
  if (typeof imageDataUrl !== "string") {
    return response.status(400).json({ error: "Analiz edilecek görsel bulunamadı." });
  }

  const match = imageDataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !allowedMimeTypes.has(match[1])) {
    return response.status(400).json({ error: "Yalnızca JPG, PNG veya WEBP görselleri analiz edilebilir." });
  }

  if (match[2].length % 4 !== 0 || match[2].length > Math.ceil(maxImageBytes / 3) * 4) {
    return response.status(400).json({ error: "Görsel boş, bozuk veya 10 MB sınırını aşıyor." });
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

    const database = await getDatabase();
    await database.collection("conversations").insertOne({
      userId: request.user.databaseId,
      type: "plant-analysis",
      messages: [
        { role: "user", content: "Bitki fotoğrafı analizi", createdAt: new Date() },
        { role: "assistant", content: `${result.plant}: ${result.condition}. ${result.description}`, createdAt: new Date() },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return response.json({ result, identificationProvider: "Pl@ntNet" });
  } catch (error) {
    if (error.code === "database_not_configured" || error.name?.startsWith("Mongo")) {
      return databaseErrorResponse(error, response);
    }
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

app.use((error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error.type === "entity.too.large") {
    return response.status(413).json({ error: "İstek boyutu sınırı aşıyor. 10 MB'dan küçük bir fotoğraf deneyin." });
  }
  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ error: "İstek verisi okunamadı. Lütfen fotoğrafı yeniden seçip deneyin." });
  }
  console.error("Unhandled API request error:", error.message);
  return response.status(500).json({ error: "Sunucuda beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." });
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
  app.use(express.static(path.resolve(__dirname, "../dist"), {
    setHeaders(response, filePath) {
      if (/-[a-z0-9_-]{8,}\./i.test(path.basename(filePath))) {
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));
  app.get("*", (_request, response) => {
    response.sendFile(path.resolve(__dirname, "../dist/index.html"));
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Tarım Asistanı sunucusu 0.0.0.0:${port} adresinde çalışıyor.`);
});
