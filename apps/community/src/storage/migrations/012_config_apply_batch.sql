-- 一括CONFIG Applyは順序と途中状態を保持し、Tenant単位でApplyを排他する。
CREATE TABLE config_apply_batches (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    requested_by_user_id  TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    source                TEXT NOT NULL CHECK (source IN ('checkpoint', 'devices')),
    source_checkpoint_id  TEXT NULL,
    source_checkpoint_name TEXT NULL,
    confirmation_mode     TEXT NOT NULL CHECK (confirmation_mode IN ('batch', 'per_device')),
    save_after_apply      INTEGER NOT NULL DEFAULT 0 CHECK (save_after_apply IN (0, 1)),
    status                TEXT NOT NULL CHECK (status IN ('preparing', 'awaiting_confirmation', 'running', 'stopping', 'stopped', 'complete')),
    current_item_id       TEXT NULL,
    stop_reason           TEXT NULL,
    plan_completed_at     TEXT NULL,
    confirmed_at          TEXT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    finished_at           TEXT NULL
);

CREATE INDEX config_apply_batches_tenant_created
    ON config_apply_batches(tenant_id, created_at DESC, id DESC);
CREATE INDEX config_apply_batches_tenant_status
    ON config_apply_batches(tenant_id, status);

CREATE TABLE config_apply_batch_items (
    id                         TEXT PRIMARY KEY,
    batch_id                   TEXT NOT NULL REFERENCES config_apply_batches(id) ON DELETE CASCADE,
    sequence                   INTEGER NOT NULL,
    device_id                  TEXT NULL REFERENCES devices(id) ON DELETE SET NULL,
    device_name                TEXT NOT NULL,
    target_backup_id           TEXT NOT NULL,
    target_content_hash        TEXT NOT NULL,
    prepared_backup_id         TEXT NULL,
    prepared_config_hash       TEXT NULL,
    execution_check_backup_id  TEXT NULL,
    execution_check_config_hash TEXT NULL,
    selected_for_execution     INTEGER NOT NULL DEFAULT 1 CHECK (selected_for_execution IN (0, 1)),
    plan_summary               TEXT NULL,
    status                     TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'no_change', 'excluded', 'queued', 'guarding', 'awaiting_confirmation', 'applying', 'applied', 'failed', 'skipped')),
    failure_code               TEXT NULL,
    apply_id                   TEXT NULL REFERENCES config_applies(id) ON DELETE SET NULL,
    apply_effect               TEXT NULL CHECK (apply_effect IN ('confirmed', 'not_applied', 'unknown')),
    save_result                TEXT NULL CHECK (save_result IN ('not_requested', 'pending', 'confirmed', 'failed', 'unconfirmed')),
    requested_at               TEXT NOT NULL,
    confirmed_at               TEXT NULL,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    finished_at                TEXT NULL,
    UNIQUE (batch_id, sequence),
    UNIQUE (apply_id)
);

CREATE INDEX config_apply_batch_items_batch_sequence
    ON config_apply_batch_items(batch_id, sequence);
CREATE INDEX config_apply_batch_items_device_status
    ON config_apply_batch_items(device_id, status);

-- owner_idはowner_typeに応じてbatch IDまたは単体config_apply IDを指す。
CREATE TABLE config_apply_locks (
    tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    owner_type   TEXT NOT NULL CHECK (owner_type IN ('batch', 'single_apply')),
    owner_id     TEXT NOT NULL,
    acquired_at  TEXT NOT NULL
);
