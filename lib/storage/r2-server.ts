import { R2StorageAdapter } from "@/src/storage/r2-adapter";

function readR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.R2_ENDPOINT;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}

export function getR2StorageOrNull(): R2StorageAdapter | null {
  const config = readR2Config();
  return config ? new R2StorageAdapter(config) : null;
}

export function getR2Storage(): R2StorageAdapter {
  const storage = getR2StorageOrNull();
  if (!storage) {
    throw new Error("R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.");
  }
  return storage;
}
