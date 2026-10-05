-- Job(docs/product/feature-list.md ジョブシステム、#25)
-- Router操作は同期処理ではなくJobとして記録する。

CREATE TABLE jobs (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id             TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type                  TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'timeout', 'cancelled')),
    request               TEXT NULL,
    output                TEXT NULL,
    error                 TEXT NULL,
    timeout_ms            INTEGER NOT NULL,
    requested_by_user_id  TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at            TEXT NOT NULL,
    started_at            TEXT NULL,
    finished_at           TEXT NULL
);
CREATE INDEX jobs_device_created ON jobs(device_id, created_at);
CREATE INDEX jobs_tenant_created ON jobs(tenant_id, created_at);
CREATE INDEX jobs_status ON jobs(status);
