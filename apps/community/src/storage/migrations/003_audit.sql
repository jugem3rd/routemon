-- 監査Event(docs/core/access-control-design.md §6)
-- 転送したHTTP bodyやCONFIG本文、secretは入れない。

CREATE TABLE audit_events (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_user_id  TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    type           TEXT NOT NULL,
    target_type    TEXT NULL,
    target_id      TEXT NULL,
    detail_json    TEXT NULL,
    created_at     TEXT NOT NULL
);
CREATE INDEX audit_events_tenant_created ON audit_events(tenant_id, created_at);
CREATE INDEX audit_events_actor ON audit_events(actor_user_id, created_at);
CREATE INDEX audit_events_target ON audit_events(target_type, target_id, created_at);
