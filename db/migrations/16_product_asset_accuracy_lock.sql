BEGIN;

ALTER TABLE public.product_assets
  ADD COLUMN original_filename TEXT,
  ADD COLUMN checksum_sha256 TEXT;

ALTER TABLE public.product_assets
  ADD CONSTRAINT product_assets_asset_type_check
    CHECK (asset_type IN ('product_closeup','packaging','logo_watermark','reference')),
  ADD CONSTRAINT product_assets_checksum_sha256_check
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');

CREATE INDEX product_assets_product_created_idx
  ON public.product_assets (workspace_id, product_id, created_at DESC);

COMMIT;
