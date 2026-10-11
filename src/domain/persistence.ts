import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { JobRecord } from '../db/job-repository';
import type { R2StorageAdapter } from '../storage/r2-adapter';
import type { RemoteAssetSource } from '../storage/remote-asset-source';

interface JobBindingRow {
  product_id: string | null;
  storyboard_id: string | null;
}

export interface PersistedGeneratedVideo {
  id: string;
  storageKey: string;
  mimeType: string;
}

export class DomainPersistence {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2StorageAdapter,
    private readonly remoteAssets: RemoteAssetSource,
  ) {}

  async saveProductDna(job: JobRecord, dnaProfile: unknown): Promise<void> {
    const binding = await this.getBinding(job);
    if (!binding.product_id) {
      throw Object.assign(new Error(`Job ${job.id} has no product binding`), {
        code: 'DOMAIN_PRODUCT_BINDING_MISSING',
      });
    }

    const result = await this.pool.query(
      `UPDATE public.products
          SET dna_profile = $1::jsonb,
              dna_source_job_id = $2,
              updated_at = now()
        WHERE id = $3 AND workspace_id = $4`,
      [JSON.stringify(dnaProfile ?? null), job.id, binding.product_id, job.workspaceId],
    );

    if (result.rowCount !== 1) {
      throw Object.assign(new Error(`Product ${binding.product_id} not found for DNA persistence`), {
        code: 'DOMAIN_PRODUCT_NOT_FOUND',
      });
    }
  }

  async persistGeneratedVideoFromUri(
    job: JobRecord,
    providerOperationId: string,
    remoteUri: string,
    signal?: AbortSignal,
    durationSeconds?: number,
  ): Promise<PersistedGeneratedVideo> {
    const binding = await this.getBinding(job);
    if (!binding.storyboard_id) {
      throw Object.assign(new Error(`Job ${job.id} has no storyboard binding`), {
        code: 'DOMAIN_STORYBOARD_BINDING_MISSING',
      });
    }

    const remote = await this.remoteAssets.open(remoteUri, signal);
    const extension = extensionForMimeType(remote.mimeType);
    const providerHash = createHash('sha256').update(providerOperationId).digest('hex').slice(0, 24);
    const storageKey = `workspaces/${job.workspaceId}/jobs/${job.id}/videos/${providerHash}.${extension}`;

    await this.storage.uploadFromStream(storageKey, remote.stream, remote.mimeType, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      providerOperationId,
    });

    const result = await this.pool.query<{
      id: string;
      storage_key: string;
      mime_type: string;
    }>(
      `INSERT INTO public.generated_videos(
         workspace_id, storyboard_id, job_id, storage_key, mime_type,
         duration_seconds, provider_operation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (job_id, storage_key) DO UPDATE
         SET mime_type = EXCLUDED.mime_type,
             duration_seconds = COALESCE(EXCLUDED.duration_seconds, public.generated_videos.duration_seconds),
             provider_operation_id = EXCLUDED.provider_operation_id
       RETURNING id, storage_key, mime_type`,
      [
        job.workspaceId,
        binding.storyboard_id,
        job.id,
        storageKey,
        remote.mimeType,
        durationSeconds ?? null,
        providerOperationId,
      ],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
    };
  }

  private async getBinding(job: JobRecord): Promise<JobBindingRow> {
    const result = await this.pool.query<JobBindingRow>(
      `SELECT product_id, storyboard_id
       FROM public.job_domain_inputs
       WHERE job_id = $1 AND workspace_id = $2`,
      [job.id, job.workspaceId],
    );

    if (result.rowCount !== 1) {
      throw Object.assign(new Error(`Job ${job.id} has no domain input binding`), {
        code: 'DOMAIN_INPUT_BINDING_MISSING',
      });
    }

    return result.rows[0];
  }
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'video/webm') return 'webm';
  if (normalized === 'video/quicktime') return 'mov';
  return 'mp4';
}
