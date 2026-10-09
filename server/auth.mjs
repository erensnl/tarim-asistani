import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDatabase } from "./database.mjs";

const deriveKey = promisify(scrypt);
const sessionCookieName = "tarim_session";
const sessionDurationMs = 1000 * 60 * 60 * 24 * 30;

export function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  const [saltHex, keyHex] = storedHash.split(":");
  if (!saltHex || !keyHex || !/^[a-f0-9]+$/i.test(saltHex) || !/^[a-f0-9]+$/i.test(keyHex)) {
    return false;
  }
  const expected = Buffer.from(keyHex, "hex");
  const actual = await deriveKey(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function getSessionCookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/",
    maxAge: sessionDurationMs,
  };
}

export function clearSessionCookie(response) {
  response.clearCookie(sessionCookieName, getSessionCookieOptions());
}

function getSessionToken(request) {
  const authorization = request.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,60})$/);
  return bearer?.[1] || request.cookies?.[sessionCookieName] || null;
}

export async function createSession(request, response, user) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const database = await getDatabase();
  await database.collection("sessions").insertOne({
    userId: user._id,
    email: user.email,
    tokenHash: hashSessionToken(token),
    ipAddress: request.ip || request.socket.remoteAddress || "unknown",
    userAgent: request.get("user-agent") || "",
    createdAt: now,
    expiresAt: new Date(now.getTime() + sessionDurationMs),
  });
  response.cookie(sessionCookieName, token, getSessionCookieOptions());
  return token;
}

export async function getCurrentSession(request) {
  const token = getSessionToken(request);
  if (!token) return null;
  const database = await getDatabase();
  const session = await database.collection("sessions").findOne({
    tokenHash: hashSessionToken(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;
  const user = await database.collection("users").findOne(
    { _id: session.userId },
    { projection: { name: 1, email: 1 } },
  );
  return user
    ? { id: user._id.toString(), databaseId: user._id, name: user.name, email: user.email, session }
    : null;
}

export async function recordAuditEvent(request, { type, email, userId = null }) {
  const database = await getDatabase();
  await database.collection("audit_events").insertOne({
    type,
    email,
    userId,
    ipAddress: request.ip || request.socket.remoteAddress || "unknown",
    userAgent: request.get("user-agent") || "",
    createdAt: new Date(),
  });
}

export async function deleteCurrentSession(request) {
  const token = getSessionToken(request);
  if (!token) return null;
  const database = await getDatabase();
  const session = await database.collection("sessions").findOneAndDelete({
    tokenHash: hashSessionToken(token),
  });
  const deleted = session?.value ?? session;
  return deleted ? { userId: deleted.userId, email: deleted.email } : null;
}

export async function requireAuthentication(request, response, next) {
  try {
    const user = await getCurrentSession(request);
    if (!user) return response.status(401).json({ error: "Devam etmek için giriş yapın." });
    request.user = user;
    return next();
  } catch (error) {
    console.error("Authentication lookup failed:", error.message);
    const configured = error.code?.startsWith("database_");
    return response.status(503).json({
      error: configured
        ? "Hesap hizmeti henüz yapılandırılmadı. Sunucu yöneticisi MongoDB URI, kullanıcı adı ve parola ayarlarını kontrol etmelidir."
        : "Hesap hizmetine şu anda ulaşılamıyor. Lütfen biraz sonra tekrar deneyin.",
    });
  }
}

export function databaseErrorResponse(error, response) {
  console.error("Database request failed:", error.message);
  return response.status(503).json({
    error: error.code?.startsWith("database_")
      ? "Hesap hizmeti henüz yapılandırılmadı. Sunucu yöneticisi MongoDB URI, kullanıcı adı ve parola ayarlarını kontrol etmelidir."
      : "Veritabanına şu anda ulaşılamıyor. Lütfen biraz sonra tekrar deneyin.",
  });
}
