-- Community Local Auth(docs/community/local-auth-design.md)
-- Password平文もSession token平文も保存しない。

CREATE TABLE local_auth_credentials (
    user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash        TEXT NOT NULL,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    locked_until         TEXT NULL,
    password_updated_at  TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
