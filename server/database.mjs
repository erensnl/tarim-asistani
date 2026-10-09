import { MongoClient } from "mongodb";

let client;
let connection;

export async function getDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    const error = new Error("MongoDB bağlantısı yapılandırılmamış.");
    error.code = "database_not_configured";
    throw error;
  }

  if (!connection) {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    connection = client.connect()
      .then(() => {
        const database = client.db(process.env.MONGODB_DATABASE || undefined);
        return Promise.all([
          database.collection("users").createIndex({ email: 1 }, { unique: true }),
          database.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true }),
          database.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
          database.collection("audit_events").createIndex({ createdAt: -1 }),
          database.collection("conversations").createIndex({ userId: 1, updatedAt: -1 }),
        ]).then(() => database);
      })
      .catch((error) => {
        connection = undefined;
        client = undefined;
        throw error;
      });
  }

  return connection;
}

export function getClient() {
  return client;
}
