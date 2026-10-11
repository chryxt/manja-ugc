import type { JobRepository } from '../../db/job-repository';
import type { DomainPersistence } from '../../domain/persistence';
import type { GeminiAdapter } from '../../providers/gemini/gemini-adapter';
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
  ugcVideo?: UgcVideoHandlerOptions;
}

export function createJobHandlers(
  dependencies: JobHandlerFactoryDependencies,
): Record<string, WorkerJobHandler> {
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
      dependencies.ugcVideo,
    ),
  };
}
