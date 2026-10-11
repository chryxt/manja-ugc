import { Readable } from 'node:stream';
import type { RemoteAsset, RemoteAssetSource } from '../../storage/remote-asset-source';

export interface GeminiVideoAssetSourceOptions {
  apiKey: string;
  allowedHosts?: readonly string[];
}

/**
 * Gemini Developer API video downloader. Google documents Veo download URIs as requiring
 * the x-goog-api-key header. Host allowlisting prevents credential forwarding to an
 * arbitrary URI if provider response data is ever corrupted or attacker-controlled.
 *
 * Vertex/ADC deployments should provide a different RemoteAssetSource implementation.
 */
export class GeminiVideoAssetSource implements RemoteAssetSource {
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(private readonly options: GeminiVideoAssetSourceOptions) {
    this.allowedHosts = new Set(options.allowedHosts ?? ['generativelanguage.googleapis.com']);
  }

  async open(uri: string, signal?: AbortSignal): Promise<RemoteAsset> {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || !this.allowedHosts.has(url.hostname)) {
      throw Object.assign(
        new Error(`Refusing to send Gemini credentials to untrusted video host ${url.hostname}`),
        { code: 'GEMINI_VIDEO_HOST_NOT_ALLOWED' },
      );
    }

    const response = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: {
        'x-goog-api-key': this.options.apiKey,
      },
    });

    if (!response.ok || !response.body) {
      throw Object.assign(
        new Error(`Gemini video download failed with HTTP ${response.status}`),
        {
          code: 'GEMINI_VIDEO_DOWNLOAD_FAILED',
          status: response.status,
        },
      );
    }

    const rawLength = response.headers.get('content-length');
    const contentLength = rawLength ? Number(rawLength) : undefined;

    return {
      stream: Readable.fromWeb(response.body as never),
      mimeType: response.headers.get('content-type') ?? 'video/mp4',
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    };
  }
}
