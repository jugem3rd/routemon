-- Deviceごとの最新Observed route table snapshotだけを保持する。
CREATE TABLE device_route_tables (
    device_id            TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    family               TEXT NOT NULL CHECK (family IN ('ipv4', 'ipv6')),
    captured_at          TEXT NULL,
    changed_at           TEXT NULL,
    content_hash         TEXT NULL,
    last_attempt_at      TEXT NOT NULL,
    last_attempt_status  TEXT NOT NULL CHECK (last_attempt_status IN ('complete', 'partial', 'failed')),
    last_error_code      TEXT NULL,
    output_bytes         INTEGER NULL CHECK (output_bytes IS NULL OR output_bytes >= 0),
    parser_version       TEXT NULL,
    routes_json          TEXT NULL,
    unparsed_lines_json  TEXT NULL,
    PRIMARY KEY (device_id, family)
);
