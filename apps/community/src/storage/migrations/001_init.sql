-- Community SQLite schema(docs/community/database-design.md、docs/core/data-model.md)
-- timestampはUTCのISO 8601 text(docs/core/data-model.md §7)。

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT,
    login_id      TEXT,
    display_name  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email_unique ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_login_id_unique ON users(login_id) WHERE login_id IS NOT NULL;

CREATE TABLE tenants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE memberships (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX memberships_tenant ON memberships(tenant_id);

CREATE TABLE sites (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX sites_tenant_name ON sites(tenant_id, name);

CREATE TABLE groups (
    id               TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    parent_group_id  TEXT NULL REFERENCES groups(id) ON DELETE SET NULL,
    name             TEXT NOT NULL,
    description      TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX groups_tenant ON groups(tenant_id);
CREATE INDEX groups_parent ON groups(parent_group_id);

CREATE TABLE tags (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (tenant_id, name)
);

CREATE TABLE devices (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id             TEXT NULL REFERENCES sites(id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    notes               TEXT,
    role                TEXT,
    environment         TEXT,
    criticality         TEXT,
    location_detail     TEXT,
    lifecycle_status    TEXT NOT NULL CHECK (lifecycle_status IN ('pending', 'active', 'disabled')),
    model               TEXT,
    serial_number       TEXT,
    firmware_revision   TEXT,
    hostname            TEXT,
    agent_version       TEXT,
    registered_at       TEXT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX devices_tenant ON devices(tenant_id);
CREATE INDEX devices_tenant_site ON devices(tenant_id, site_id);
CREATE INDEX devices_tenant_lifecycle ON devices(tenant_id, lifecycle_status);
CREATE INDEX devices_serial ON devices(serial_number);

CREATE TABLE device_groups (
    device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, group_id)
);
CREATE INDEX device_groups_group ON device_groups(group_id);

CREATE TABLE device_tags (
    device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, tag_id)
);
CREATE INDEX device_tags_tag ON device_tags(tag_id);

-- Enrollment Code平文は保存しない(docs/core/device-enrollment-design.md)
CREATE TABLE device_enrollments (
    id                   TEXT PRIMARY KEY,
    device_id            TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    code_hash            TEXT NOT NULL,
    expires_at           TEXT NOT NULL,
    used_at              TEXT NULL,
    created_by_user_id   TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at           TEXT NOT NULL
);
CREATE INDEX device_enrollments_device ON device_enrollments(device_id);
CREATE INDEX device_enrollments_expires ON device_enrollments(expires_at);
CREATE UNIQUE INDEX device_enrollments_code_hash ON device_enrollments(code_hash);

-- Device Token平文は保存しない
CREATE TABLE device_credentials (
    id            TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at    TEXT NOT NULL,
    last_used_at  TEXT NULL,
    revoked_at    TEXT NULL
);
CREATE UNIQUE INDEX device_credentials_token_hash ON device_credentials(token_hash);
CREATE INDEX device_credentials_device_status ON device_credentials(device_id, status);

-- 現在値兼履歴。Heartbeatごとには更新せず、変更時に旧recordを終了する
CREATE TABLE device_addresses (
    id             TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    family         TEXT NOT NULL CHECK (family IN ('ipv4', 'ipv6')),
    address        TEXT NOT NULL,
    prefix_length  INTEGER NULL,
    interface      TEXT NULL,
    source         TEXT NOT NULL CHECK (source IN ('observed', 'agent')),
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    ended_at       TEXT NULL
);
CREATE INDEX device_addresses_device_ended ON device_addresses(device_id, ended_at);
CREATE INDEX device_addresses_device_family_source ON device_addresses(device_id, family, source);

-- Structured Event(Raw SYSLOG行は複製しない、docs/core/syslog-design.md §3.2)
CREATE TABLE device_events (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id    TEXT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,
    severity     TEXT NOT NULL,
    detail_json  TEXT NULL,
    occurred_at  TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX device_events_tenant_created ON device_events(tenant_id, created_at);
CREATE INDEX device_events_device_occurred ON device_events(device_id, occurred_at);

-- 本文は暗号化してfilesystemへ置き、ここにはmetadataとstorage keyだけを持つ
CREATE TABLE device_config_backups (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id           TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    storage_key         TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    size_bytes          INTEGER NOT NULL,
    encryption_version  INTEGER NOT NULL,
    nonce               TEXT NOT NULL,
    firmware_revision   TEXT,
    hostname            TEXT,
    source              TEXT NOT NULL,
    created_by_user_id  TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    captured_at         TEXT NOT NULL,
    created_at          TEXT NOT NULL
);
CREATE INDEX device_config_backups_device_captured ON device_config_backups(device_id, captured_at);
CREATE INDEX device_config_backups_tenant_captured ON device_config_backups(tenant_id, captured_at);

-- Instance設定(Setup Wizard等、#12)
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
