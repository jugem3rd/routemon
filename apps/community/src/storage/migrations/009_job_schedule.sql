-- 予約実行(#54)。queuedのままscheduled_atを持ち、時刻が来たら実行する
ALTER TABLE jobs ADD COLUMN scheduled_at TEXT;
CREATE INDEX jobs_scheduled ON jobs(scheduled_at) WHERE scheduled_at IS NOT NULL;
