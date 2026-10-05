-- CONFIG checkpointは複数Deviceの取得結果を束ねる。世代本文は保存しない。
CREATE TABLE config_checkpoints (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    memo                 TEXT NULL,
    created_by_user_id   TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at           TEXT NOT NULL
);

CREATE INDEX config_checkpoints_tenant_created
    ON config_checkpoints(tenant_id, created_at DESC, id DESC);

CREATE TABLE config_checkpoint_items (
    id              TEXT PRIMARY KEY,
    checkpoint_id   TEXT NOT NULL REFERENCES config_checkpoints(id) ON DELETE CASCADE,
    device_id       TEXT NULL REFERENCES devices(id) ON DELETE SET NULL,
    device_name     TEXT NOT NULL,
    backup_id       TEXT NULL REFERENCES device_config_backups(id) ON DELETE SET NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'captured', 'failed')),
    failure_code    TEXT NULL CHECK (failure_code IN (
                        'device_offline', 'device_not_found', 'checkpoint_in_progress', 'request_failed',
                        'response_timeout', 'server_restarted', 'backup_unavailable'
                    )),
    requested_at    TEXT NOT NULL,
    captured_at     TEXT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (checkpoint_id, device_id),
    CHECK (
        (status = 'pending' AND backup_id IS NULL AND failure_code IS NULL AND captured_at IS NULL)
        OR (status = 'captured' AND failure_code IS NULL AND captured_at IS NOT NULL)
        OR (status = 'failed' AND backup_id IS NULL AND failure_code IS NOT NULL AND captured_at IS NULL)
    )
);

CREATE INDEX config_checkpoint_items_checkpoint
    ON config_checkpoint_items(checkpoint_id, requested_at, id);
CREATE UNIQUE INDEX config_checkpoint_items_pending_device
    ON config_checkpoint_items(device_id)
    WHERE status = 'pending' AND device_id IS NOT NULL;
