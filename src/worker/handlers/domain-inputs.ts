import type { JobRecord } from '../../db/job-repository';
import type { GeminiTextPayload, GeminiVideoPayload } from '../../providers/gemini/gemini-adapter';
import type { OpenAIProviderPayload } from '../../providers/openai/openai-adapter';

/**
 * Domain inputs remain authoritative outside BullMQ. Implementations may load them from
 * products/assets/storyboards/object storage, but handlers never receive business payloads
 * from the queue.
 */
export interface JobDomainInputResolver {
  getProductDnaPayload(job: JobRecord): Promise<GeminiTextPayload>;
  getUgcScriptPayload(job: JobRecord): Promise<OpenAIProviderPayload>;
  getVeoPayload(job: JobRecord, script: string): Promise<GeminiVideoPayload>;
}
