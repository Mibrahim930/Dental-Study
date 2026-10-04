// Backup bucket access (S3-compatible). No database imports, so the restore script can use it.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

export function backupConfigured(): boolean {
  return !!(process.env.BACKUP_S3_ENDPOINT && process.env.BACKUP_S3_BUCKET && process.env.BACKUP_S3_ACCESS_KEY_ID);
}

export function s3(): { client: S3Client; bucket: string } {
  return {
    bucket: process.env.BACKUP_S3_BUCKET!,
    client: new S3Client({
      endpoint: process.env.BACKUP_S3_ENDPOINT,
      region: process.env.BACKUP_S3_REGION || "auto",
      credentials: { accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY! },
    }),
  };
}

export async function downloadObject(key: string): Promise<Buffer> {
  const { client, bucket } = s3();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function listObjects(prefix: string): Promise<string[]> {
  const { client, bucket } = s3();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(res.Contents ?? []).map((o) => o.Key!));
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}
