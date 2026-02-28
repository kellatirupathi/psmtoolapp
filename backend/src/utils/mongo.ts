import { MongoClient } from "mongodb";

const DEFAULT_DB_NAME = "psm_analyser";

let clientPromise: Promise<MongoClient> | null = null;

const getMongoUrl = (): string => {
  const url = process.env.MONGODB_URL ?? process.env.MONGODB_URI ?? "";
  if (!url.trim()) {
    throw new Error("Missing MongoDB connection string. Set MONGODB_URL.");
  }
  return url.trim();
};

const getMongoDbName = (): string => {
  return (process.env.MONGODB_DB_NAME ?? DEFAULT_DB_NAME).trim() || DEFAULT_DB_NAME;
};

export const getMongoClient = async (): Promise<MongoClient> => {
  if (!clientPromise) {
    const client = new MongoClient(getMongoUrl());
    clientPromise = client.connect();
  }
  return clientPromise;
};

export const getMongoDb = async () => {
  const client = await getMongoClient();
  return client.db(getMongoDbName());
};
