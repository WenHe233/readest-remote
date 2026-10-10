-- External library connection metadata. Credential values are encrypted by
-- the existing replica crypto middleware before reaching fields_jsonb.
ALTER TABLE public.replicas DROP CONSTRAINT IF EXISTS replicas_kind_allowlist;
ALTER TABLE public.replicas ADD CONSTRAINT replicas_kind_allowlist CHECK
  (kind IN ('dictionary', 'font', 'texture', 'opds_catalog', 'abs_server',
            'settings', 'bookshelf', 'custom_translator', 'translation_prompt',
            'plugin_connection'));
