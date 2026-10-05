-- CONFIGの内容比較用key(#6)
-- `show config`は取得のたびに`# Reporting Date:`が変わるため、その行を除いたhashで
-- 同一内容かどうかを判定する。NULLの既存行はcontent_hashで比較する。
ALTER TABLE device_config_backups ADD COLUMN dedupe_key TEXT;
