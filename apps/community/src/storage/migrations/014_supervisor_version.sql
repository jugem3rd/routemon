-- Supervisor自身の更新(#159)
-- supervisor_version: Agentが報告している、動いているSupervisorのversion
ALTER TABLE devices ADD COLUMN supervisor_version TEXT;
-- desired_supervisor_version: 導入したいSupervisorのversion。報告されたversionと違えば、UPDATE_AVAILABLE
-- (supervisor-<version>)を送る
ALTER TABLE devices ADD COLUMN desired_supervisor_version TEXT;
