-- Routemonが管理するCONFIG状態。savedはRouterの完全な保存を検査済みという意味ではなく、
-- Routemonが未保存として管理していないことを表す。
ALTER TABLE devices
    ADD COLUMN config_state TEXT NOT NULL DEFAULT 'saved'
        CHECK (config_state IN ('saved', 'unsaved'));

-- CONFIG本文は保存せず、暗号化されたbackupと操作の関連だけを保持する。
CREATE TABLE config_applies (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id             TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    target_backup_id      TEXT NULL REFERENCES device_config_backups(id) ON DELETE SET NULL,
    pre_apply_backup_id   TEXT NULL REFERENCES device_config_backups(id) ON DELETE SET NULL,
    target_content_hash   TEXT NOT NULL,
    requested_by_user_id  TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    save_after_apply      INTEGER NOT NULL DEFAULT 0 CHECK (save_after_apply IN (0, 1)),
    phase                 TEXT NOT NULL CHECK (phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify', 'complete', 'failed')),
    apply_result          TEXT NULL CHECK (apply_result IN ('matched', 'mismatch', 'unavailable', 'failed')),
    save_job_id           TEXT NULL REFERENCES jobs(id) ON DELETE SET NULL,
    discard_reboot_job_id TEXT NULL REFERENCES jobs(id) ON DELETE SET NULL,
    error_code            TEXT NULL,
    prepared_at           TEXT NOT NULL,
    confirmed_at          TEXT NULL,
    activated_at          TEXT NULL,
    verified_at           TEXT NULL,
    finished_at           TEXT NULL,
    saved_at              TEXT NULL,
    discarded_at          TEXT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

CREATE INDEX config_applies_tenant_device
    ON config_applies(tenant_id, device_id, created_at DESC);
CREATE INDEX config_applies_target_backup
    ON config_applies(target_backup_id);
CREATE INDEX config_applies_pre_apply_backup
    ON config_applies(pre_apply_backup_id);
CREATE UNIQUE INDEX config_applies_active_device
    ON config_applies(device_id)
    WHERE phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify');
