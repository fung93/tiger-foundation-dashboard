-- Private storage accounting only; no financial history or journal is deleted.
CREATE TABLE IF NOT EXISTS agent_storage_metrics (
  id INTEGER PRIMARY KEY CHECK (id=1), rows_count INTEGER NOT NULL, bytes_count INTEGER NOT NULL
);
INSERT OR IGNORE INTO agent_storage_metrics(id,rows_count,bytes_count)
  SELECT 1,COUNT(*),COALESCE(SUM(length(CAST(key AS BLOB))+length(CAST(value AS BLOB))),0) FROM agent_state;
CREATE TRIGGER IF NOT EXISTS agent_storage_insert AFTER INSERT ON agent_state BEGIN
  UPDATE agent_storage_metrics SET rows_count=rows_count+1,
    bytes_count=bytes_count+length(CAST(NEW.key AS BLOB))+length(CAST(NEW.value AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS agent_storage_delete AFTER DELETE ON agent_state BEGIN
  UPDATE agent_storage_metrics SET rows_count=rows_count-1,
    bytes_count=bytes_count-length(CAST(OLD.key AS BLOB))-length(CAST(OLD.value AS BLOB)) WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS agent_storage_update AFTER UPDATE ON agent_state BEGIN
  UPDATE agent_storage_metrics SET bytes_count=bytes_count-length(CAST(OLD.key AS BLOB))-length(CAST(OLD.value AS BLOB))
    +length(CAST(NEW.key AS BLOB))+length(CAST(NEW.value AS BLOB)) WHERE id=1;
END;
