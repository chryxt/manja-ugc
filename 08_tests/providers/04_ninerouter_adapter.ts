import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { NineRouterAdapter } from '../../src/providers/ninerouter/ninerouter-adapter.js';

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ content?: string }> };
      assert.equal(parsed.model, 'router-test-model');
      assert.equal(parsed.messages?.[0]?.content, 'write a short UGC hook');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-router-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'router-test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hook: stop scrolling.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    const adapter = new NineRouterAdapter({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
    });
    const result = await adapter.submit(
      'op-1',
      'script_generation',
      { model: 'router-test-model', input: 'write a short UGC hook' },
      { jobId: 'job-1', operationId: 'op-1', workspaceId: 'workspace-1' },
    );

    assert.equal(result.providerOperationId, 'chatcmpl-router-test');
    assert.equal(result.responsePayload?.output_text, 'Hook: stop scrolling.');
    assert.equal(adapter.capabilities.externalIdempotency, false);
    assert.equal(adapter.capabilities.asyncStatus, false);
    console.log('PASS 9Router OpenAI-compatible adapter smoke');
  } finally {
    server.close();
    await once(server, 'close');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
