-- Agent A/B Update(#35)
-- desired_agent_version: 導入したいversion。Agentが報告したversionと違えばUPDATE_AVAILABLEを送る
ALTER TABLE devices ADD COLUMN desired_agent_version TEXT;
-- agent_slot: Agentが報告している稼働slot(a / b)
ALTER TABLE devices ADD COLUMN agent_slot TEXT;
