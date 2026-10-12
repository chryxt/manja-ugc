# 9Router integration

9Router is used as an optional text-routing layer for cost-sensitive UGC script generation.
It is not a source of truth for job state, billing, lineage, or settlement.

## Boundary

MANJA -> 9Router OpenAI-compatible endpoint -> provider/account selected by 9Router.

MANJA never stores or rotates Gemini/Claude/Codex subscription credentials. Those remain inside the 9Router instance. This keeps provider-account routing outside the application billing/state machine.

## Current scope

- UGC script generation: supported.
- Product DNA: stays on Gemini for now because the current Product DNA path is designed around product asset/vision context.
- Video generation: unchanged (mock/Veo today; other video adapters can be added separately).

## Configuration

Set the worker environment:

```bash
UGC_SCRIPT_PROVIDER=ninerouter
NINEROUTER_BASE_URL=http://127.0.0.1:20128/v1
# Optional when the router endpoint requires bearer auth:
NINEROUTER_API_KEY=...
```

The UGC script model continues to come from the domain resolver (`ugcScriptModel`). Configure that model name to a model/combo that the connected 9Router instance understands.

For local development, the documented 9Router default is `http://localhost:20128/v1`.
For a cloud worker, do not point to localhost unless 9Router runs in the same network/container. Expose it only through an authenticated private endpoint/tunnel and set `NINEROUTER_BASE_URL` accordingly.

## Retry/idempotency safety

The 9Router chat route is treated as synchronous and as having no verified external idempotency primitive.
Therefore:

- HTTP 429/503 can be classified as transient.
- ambiguous transport/timeouts are classified `FATAL_P0`, not blindly resubmitted.
- if a recovered DB operation is non-terminal (`in_progress`/`submitted`), the worker stops for reconciliation rather than risking duplicate provider spend.

9Router can perform its own provider/account fallback internally; MANJA does not layer another blind cross-provider retry over an ambiguous request.
