CREATE TABLE IF NOT EXISTS system_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),instance_id uuid NOT NULL DEFAULT gen_random_uuid(),data_epoch uuid NOT NULL DEFAULT gen_random_uuid(),revision bigint NOT NULL DEFAULT 1);
INSERT INTO system_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_versions WHERE version=2) THEN
 ALTER TABLE collectors ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'bound', ADD COLUMN protocol_version integer NOT NULL DEFAULT 1, ADD COLUMN enrollment_nonce text NOT NULL DEFAULT '', ADD COLUMN binding_id uuid NOT NULL DEFAULT gen_random_uuid();
 ALTER TABLE devices ALTER COLUMN collector_id DROP NOT NULL;
 ALTER TABLE devices DROP CONSTRAINT devices_collector_id_fkey;
 ALTER TABLE devices ADD CONSTRAINT devices_collector_id_fkey FOREIGN KEY(collector_id) REFERENCES collectors(id) ON DELETE SET NULL;
 ALTER TABLE devices ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active';
 ALTER TABLE measurements ADD COLUMN source_collector_id text,ADD COLUMN source_device_name text;
 UPDATE measurements m SET source_collector_id=m.collector_id,source_device_name=d.name FROM devices d WHERE d.id=m.device_id;
 ALTER TABLE measurements ALTER COLUMN collector_id DROP NOT NULL;
 ALTER TABLE measurements DROP CONSTRAINT measurements_collector_id_fkey;
 ALTER TABLE measurements ADD CONSTRAINT measurements_collector_id_fkey FOREIGN KEY(collector_id) REFERENCES collectors(id) ON DELETE SET NULL;
 ALTER TABLE receipts ADD COLUMN binding_id text NOT NULL DEFAULT '', ADD COLUMN data_epoch text NOT NULL DEFAULT '';
 ALTER TABLE receipts DROP CONSTRAINT receipts_pkey;
 ALTER TABLE receipts ADD PRIMARY KEY(collector_id,binding_id,data_epoch,message_id);
 INSERT INTO schema_versions(version) VALUES(2);
END IF; END $$;
CREATE TABLE IF NOT EXISTS collector_candidates(id text PRIMARY KEY,enrollment_nonce text NOT NULL DEFAULT '',protocol_version integer NOT NULL DEFAULT 1,status jsonb NOT NULL DEFAULT '{}',last_seen timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS collector_tombstones(id text PRIMARY KEY,binding_id uuid NOT NULL,enrollment_nonce text NOT NULL,config_version bigint NOT NULL,deleted_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),type text NOT NULL,scope text NOT NULL DEFAULT '',collector_id text,device_id uuid,status text NOT NULL DEFAULT 'pending',phase text NOT NULL DEFAULT 'execute',request jsonb NOT NULL DEFAULT '{}',result jsonb NOT NULL DEFAULT '{}',error text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS operation_targets(operation_id uuid NOT NULL REFERENCES operations(id) ON DELETE CASCADE,collector_id text NOT NULL,binding_id uuid NOT NULL,data_epoch uuid NOT NULL,status text NOT NULL DEFAULT 'pending',payload jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operation_id,collector_id));
CREATE TABLE IF NOT EXISTS operation_previews(token uuid PRIMARY KEY DEFAULT gen_random_uuid(),type text NOT NULL,collector_id text,scope text NOT NULL DEFAULT '',data_epoch uuid NOT NULL,revision bigint NOT NULL,counts jsonb NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes');
CREATE TABLE IF NOT EXISTS baseline_chunks(operation_id uuid NOT NULL REFERENCES operations(id) ON DELETE CASCADE,collector_id text NOT NULL,device_id uuid NOT NULL,chunk_index integer NOT NULL CHECK(chunk_index>=0),total_chunks integer NOT NULL CHECK(total_chunks>0 AND total_chunks<=16),records jsonb NOT NULL,PRIMARY KEY(operation_id,collector_id,device_id,chunk_index));
CREATE TABLE IF NOT EXISTS device_baselines(device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,user_slot integer NOT NULL CHECK(user_slot IN(1,2)),record_hash text NOT NULL CHECK(length(record_hash)=64),PRIMARY KEY(device_id,user_slot,record_hash));
