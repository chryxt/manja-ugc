import { Readable } from 'node:stream';
import type {
  GeminiAdapterOptions,
  GeminiProviderMetadata,
  GeminiProviderPayload,
  GeminiProviderResponse,
} from '../providers/gemini/gemini-adapter';
import { GeminiAdapter } from '../providers/gemini/gemini-adapter';
import type {
  ProviderRequestMetadata,
  ProviderStatusResult,
  ProviderSubmissionResult,
} from '../providers/types';
import type { RemoteAsset, RemoteAssetSource } from '../storage/remote-asset-source';

export type E2EVideoMode = 'live' | 'mock';

export class E2EGeminiAdapter extends GeminiAdapter {
  constructor(
    private readonly videoMode: E2EVideoMode,
    options: GeminiAdapterOptions = {},
  ) {
    super(options);
  }

  override async submit(
    operationId: string,
    operationType: string,
    payload: GeminiProviderPayload,
    context: ProviderRequestMetadata,
    abortSignal?: AbortSignal,
  ): Promise<ProviderSubmissionResult<GeminiProviderResponse, GeminiProviderMetadata>> {
    if (this.videoMode === 'mock' && payload.kind === 'video') {
      if (context.operationId !== operationId) {
        throw new Error(`Mock Veo context mismatch for operation ${operationId}`);
      }

      return {
        providerOperationId: `mock-veo-${operationId}`,
        metadata: {
          operationType,
          mode: 'async',
          model: payload.model,
          operationId,
          operationMetadata: { mocked: true },
        },
      };
    }

    return super.submit(operationId, operationType, payload, context, abortSignal);
  }

  override async getStatus(
    providerOperationId: string,
    operationType: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderStatusResult<GeminiProviderResponse, GeminiProviderMetadata>> {
    if (this.videoMode === 'mock' && providerOperationId.startsWith('mock-veo-')) {
      if (abortSignal?.aborted) {
        throw new DOMException('Mock Veo polling aborted', 'AbortError');
      }

      return {
        isTerminal: true,
        isSuccess: true,
        responsePayload: {
          generatedVideos: [
            {
              video: {
                uri: `mock://veo/${providerOperationId}`,
              },
            },
          ],
        } as unknown as GeminiProviderResponse,
        metadata: {
          operationType,
          mode: 'async',
          operationId: providerOperationId,
          operationMetadata: { mocked: true, done: true },
        },
      };
    }

    return super.getStatus(providerOperationId, operationType, abortSignal);
  }
}

export class E2ERemoteAssetSource implements RemoteAssetSource {
  constructor(
    private readonly videoMode: E2EVideoMode,
    private readonly liveSource: RemoteAssetSource,
  ) {}

  async open(uri: string, signal?: AbortSignal): Promise<RemoteAsset> {
    if (this.videoMode === 'mock' && uri.startsWith('mock://veo/')) {
      if (signal?.aborted) {
        throw new DOMException('Mock video download aborted', 'AbortError');
      }

      const bytes = Buffer.from(
        'MANJA-UGC-E2E-MOCK-MP4\nThis is a deterministic sandbox placeholder, not a playable video.\n',
        'utf8',
      );

      return {
        stream: Readable.from([bytes]),
        mimeType: 'video/mp4',
        contentLength: bytes.length,
      };
    }

    return this.liveSource.open(uri, signal);
  }
}
