import "dotenv/config";
import { getClient, getDatabase } from "../server/database.mjs";

try {
  const database = await getDatabase();
  await database.command({ ping: 1 });
  console.log("MongoDB bağlantısı başarılı.");
} catch (error) {
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  console.error(
    `MongoDB bağlantısı kurulamadı${code}. MONGODB_URI, Atlas IP erişim izni ve veritabanı kullanıcısını kontrol edin.`,
  );
  process.exitCode = 1;
} finally {
  const client = getClient();
  if (client) {
    try {
      await client.close();
    } catch {
      console.error("MongoDB bağlantısı test sonrasında kapatılamadı.");
      process.exitCode = 1;
    }
  }
}
