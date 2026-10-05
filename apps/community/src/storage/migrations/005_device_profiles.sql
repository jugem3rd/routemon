-- Device Profile(#6、docs/core/device-profile-discovery-design.md)
-- CONFIGから抽出したfactsを保持する。Runtime stateは含めない。
CREATE TABLE device_profiles (
    device_id       TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    profile         TEXT NOT NULL,
    config_hash     TEXT NOT NULL,
    captured_at     TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
