import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

export interface R2StorageOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
}

export interface StoredObject {
  key: string;
  etag?: string;
}

export class R2StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: R2StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: 'auto',
      endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async uploadFromStream(
    key: string,
    stream: Readable,
    mimeType: string,
    metadata?: Record<string, string>,
  ): Promise<StoredObject> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: mimeType,
        Metadata: metadata,
      },
      leavePartsOnError: false,
    });

    const result = await upload.done();
    return {
      key,
      etag: result.ETag,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async generatePresignedUrl(key: string, expirySeconds = 3600): Promise<string> {
    if (expirySeconds < 1 || expirySeconds > 604800) {
      throw new Error('R2 presigned URL expiry must be between 1 and 604800 seconds');
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expirySeconds },
    );
  }
}
