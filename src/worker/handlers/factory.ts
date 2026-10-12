import type { JobRepository } from '../../db/job-repository';
import type { DomainPersistence } from '../../domain/persistence';
import type { GeminiAdapter } from '../../providers/gemini/gemini-adapter';
import { NineRouterAdapter } from '../../providers/ninerouter/ninerouter-adapter';
import type { OpenAIAdapter } from '../../providers/openai/openai-adapter';
import type { WorkerJobHandler } from '../job-processor';
import type { JobDomainInputResolver } from './domain-inputs';
import { ProductDnaHandler } from './product-dna';
import { UgcVideoHandler, type UgcVideoHandlerOptions } from './ugc-video';

export interface JobHandlerFactoryDependencies {
  jobs: JobRepository;
  inputs: JobDomainInputResolver;
  persistence: DomainPersistence;
  openai: OpenAIAdapter;
  gemini: GeminiAdapter;
  ninerouter?: NineRouterAdapter;
  ugcVideo?: UgcVideoHandlerOptions;
}

export function createJobHandlers(
  dependencies: JobHandlerFactoryDependencies,
): Record<string, WorkerJobHandler> {
  const scriptProvider = dependencies.ugcVideo?.scriptProvider ?? process.env.UGC_SCRIPT_PROVIDER ?? 'openai';
  const ninerouter =
    dependencies.ninerouter ??
    (scriptProvider === 'ninerouter' ? new NineRouterAdapter() : undefined);

  return {
    product_dna: new ProductDnaHandler(
      dependencies.jobs,
      dependencies.inputs,
      dependencies.persistence,
      dependencies.gemini,
    ),
    ugc_video: new UgcVideoHandler(
      dependencies.jobs,
      dependencies.inputs,
      dependencies.persistence,
      dependencies.openai,
      dependencies.gemini,
      ninerouter,
      dependencies.ugcVideo,
    ),
  };
}
