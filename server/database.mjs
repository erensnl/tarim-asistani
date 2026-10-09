import { MongoClient } from "mongodb";

let client;
let connection;

export function getMongoConnectionSettings(environment = process.env) {
  const configuredUri = environment.MONGODB_URI?.trim();
  if (!configuredUri) {
    const error = new Error("MongoDB URI is not configured.");
    error.code = "database_not_configured";
    throw error;
  }

  const username = environment.MONGODB_USERNAME;
  const password = environment.MONGODB_PASSWORD;
  if (Boolean(username) !== Boolean(password)) {
    const error = new Error("MongoDB username and password must be configured together.");
    error.code = "database_credentials_incomplete";
    throw error;
  }

  let uri = configuredUri;
  if (username && password) {
    try {
      const parsedUri = new URL(configuredUri);
      if (!["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol) || !parsedUri.hostname) {
        throw new Error("Invalid MongoDB URI.");
      }
      parsedUri.username = username;
      parsedUri.password = password;
      uri = parsedUri.toString();
    } catch {
      const error = new Error("MongoDB URI must be a valid mongodb:// or mongodb+srv:// URL.");
      error.code = "database_invalid_uri";
      throw error;
    }
  }

  return { uri, options: { serverSelectionTimeoutMS: 8000 } };
}

export async function getDatabase() {
  const { uri, options } = getMongoConnectionSettings();

  if (!connection) {
    client = new MongoClient(uri, options);
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
