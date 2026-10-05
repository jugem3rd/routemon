-- Routerの稼働状態(#54)。CONFIGから読めるfactsとは別に、実行時の観測値を持つ
-- (docs/core/device-profile-discovery-design.md: Configuration factsとRuntime stateは分離する)
ALTER TABLE devices ADD COLUMN booted_at TEXT;
ALTER TABLE devices ADD COLUMN runtime_observed_at TEXT;
