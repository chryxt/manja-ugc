import type { Pool } from 'pg';
import type { JobRecord } from '../db/job-repository';
import type { GeminiTextPayload, GeminiVideoPayload } from '../providers/gemini/gemini-adapter';
import type { OpenAIProviderPayload } from '../providers/openai/openai-adapter';
import type { R2StorageAdapter } from '../storage/r2-adapter';
import type { JobDomainInputResolver } from '../worker/handlers/domain-inputs';

export interface JobDomainResolverOptions {
  productDnaModel: string;
  ugcScriptModel: string;
  veoModel: string;
  assetUrlTtlSeconds?: number;
}

interface DomainBindingRow {
  product_id: string | null;
  storyboard_id: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
}

interface AssetRow {
  asset_type: string;
  storage_key: string;
  mime_type: string | null;
}

interface StoryboardRow {
  id: string;
  script_content: string | null;
  visual_prompts: unknown;
  payload: unknown;
}

export class PostgresJobDomainResolver implements JobDomainInputResolver {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2StorageAdapter,
    private readonly options: JobDomainResolverOptions,
  ) {}

  async getProductDnaPayload(job: JobRecord): Promise<GeminiTextPayload> {
    const { product, assets } = await this.loadProductContext(job);
    const assetRefs = await Promise.all(
      assets.map(async (asset) => ({
        type: asset.asset_type,
        mimeType: asset.mime_type,
        url: await this.storage.generatePresignedUrl(
          asset.storage_key,
          this.options.assetUrlTtlSeconds ?? 900,
        ),
      })),
    );

    return {
      kind: 'text',
      model: this.options.productDnaModel,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Extract a structured Product DNA profile for this product.',
                `Product name: ${product.name}`,
                `Description: ${product.description ?? ''}`,
                `Authoritative product asset references: ${JSON.stringify(assetRefs)}`,
                'Return concise JSON-ready product traits, positioning, visual identity, claims, and cautions.',
              ].join('\n'),
            },
          ],
        },
      ],
    };
  }

  async getUgcScriptPayload(job: JobRecord): Promise<OpenAIProviderPayload> {
    const { product, assets } = await this.loadProductContext(job);
    const binding = await this.getBinding(job);
    const storyboard = binding.storyboard_id
      ? await this.getStoryboard(job.workspaceId, binding.storyboard_id)
      : null;

    return {
      model: this.options.ugcScriptModel,
      input: [
        'Create a concise UGC video script.',
        `Product: ${product.name}`,
        `Description: ${product.description ?? ''}`,
        `Available assets: ${assets.map((asset) => asset.asset_type).join(', ') || 'none'}`,
        storyboard?.script_content ? `Existing storyboard guidance: ${storyboard.script_content}` : '',
        storyboard ? `Visual prompts: ${JSON.stringify(storyboard.visual_prompts)}` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  async getVeoPayload(job: JobRecord, script: string): Promise<GeminiVideoPayload> {
    const binding = await this.getBinding(job);
    const storyboard = binding.storyboard_id
      ? await this.getStoryboard(job.workspaceId, binding.storyboard_id)
      : null;

    const visualPrompt = storyboard ? JSON.stringify(storyboard.visual_prompts) : '';
    return {
      kind: 'video',
      model: this.options.veoModel,
      source: {
        prompt: [script, visualPrompt].filter(Boolean).join('\n\n'),
      },
    };
  }

  private async loadProductContext(job: JobRecord): Promise<{ product: ProductRow; assets: AssetRow[] }> {
    const binding = await this.getBinding(job);
    if (!binding.product_id) {
      throw Object.assign(new Error(`Job ${job.id} has no product binding`), {
        code: 'DOMAIN_PRODUCT_BINDING_MISSING',
      });
    }

    const productResult = await this.pool.query<ProductRow>(
      `SELECT id, name, description
       FROM public.products
       WHERE id = $1 AND workspace_id = $2`,
      [binding.product_id, job.workspaceId],
    );
    if (productResult.rowCount !== 1) {
      throw Object.assign(new Error(`Product ${binding.product_id} not found in workspace`), {
        code: 'DOMAIN_PRODUCT_NOT_FOUND',
      });
    }

    const assetsResult = await this.pool.query<AssetRow>(
      `SELECT asset_type, storage_key, mime_type
       FROM public.product_assets
       WHERE product_id = $1 AND workspace_id = $2
       ORDER BY created_at`,
      [binding.product_id, job.workspaceId],
    );

    return { product: productResult.rows[0], assets: assetsResult.rows };
  }

  private async getBinding(job: JobRecord): Promise<DomainBindingRow> {
    const result = await this.pool.query<DomainBindingRow>(
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

  private async getStoryboard(workspaceId: string, storyboardId: string): Promise<StoryboardRow> {
    const result = await this.pool.query<StoryboardRow>(
      `SELECT id, script_content, visual_prompts, payload
       FROM public.storyboards
       WHERE id = $1 AND workspace_id = $2`,
      [storyboardId, workspaceId],
    );
    if (result.rowCount !== 1) {
      throw Object.assign(new Error(`Storyboard ${storyboardId} not found in workspace`), {
        code: 'DOMAIN_STORYBOARD_NOT_FOUND',
      });
    }
    return result.rows[0];
  }
}
