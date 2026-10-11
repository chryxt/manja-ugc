import { Readable } from 'node:stream';

export interface RemoteAsset {
  stream: Readable;
  mimeType: string;
  contentLength?: number;
}

export interface RemoteAssetSource {
  open(uri: string, signal?: AbortSignal): Promise<RemoteAsset>;
}

/**
 * Default implementation for directly downloadable HTTPS assets.
 * Provider-specific authenticated download flows can implement the same port.
 */
export class HttpRemoteAssetSource implements RemoteAssetSource {
  async open(uri: string, signal?: AbortSignal): Promise<RemoteAsset> {
    const response = await fetch(uri, { signal });
    if (!response.ok || !response.body) {
      const error = Object.assign(
        new Error(`Remote asset download failed with HTTP ${response.status}`),
        { status: response.status, code: 'REMOTE_ASSET_DOWNLOAD_FAILED' },
      );
      throw error;
    }

    const rawLength = response.headers.get('content-length');
    const contentLength = rawLength ? Number(rawLength) : undefined;

    return {
      stream: Readable.fromWeb(response.body as never),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    };
  }
}
