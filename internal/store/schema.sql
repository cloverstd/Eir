CREATE TABLE IF NOT EXISTS schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collectors (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100), name text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '', status jsonb NOT NULL DEFAULT '{}', last_seen timestamptz, config_version bigint NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, collector_id text NOT NULL REFERENCES collectors(id), address text NOT NULL, address_type integer NOT NULL DEFAULT 0 CHECK(address_type IN (0,1)), serial_number text NOT NULL DEFAULT '', model text NOT NULL DEFAULT 'HEM-7374T1', profile text NOT NULL DEFAULT 'omron-hem-7374t1', timezone text NOT NULL DEFAULT 'Asia/Shanghai', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(address,address_type)
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_unique ON devices(serial_number) WHERE serial_number<>'';
CREATE TABLE IF NOT EXISTS bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL REFERENCES devices(id), user_slot integer NOT NULL CHECK(user_slot IN (1,2)), member_id uuid NOT NULL REFERENCES members(id), effective_from timestamptz NOT NULL, effective_to timestamptz, CHECK(effective_to IS NULL OR effective_to>effective_from), UNIQUE(device_id,user_slot,effective_from)
);
CREATE TABLE IF NOT EXISTS measurements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text NOT NULL UNIQUE, device_id uuid NOT NULL REFERENCES devices(id), collector_id text NOT NULL REFERENCES collectors(id), user_slot integer NOT NULL CHECK(user_slot IN(1,2)), kind text NOT NULL DEFAULT 'blood_pressure', record_sequence integer NOT NULL, device_time text NOT NULL, measured_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(), timezone text NOT NULL, member_id uuid REFERENCES members(id), manual_assignment boolean NOT NULL DEFAULT false, notes text NOT NULL DEFAULT '', raw_data bytea NOT NULL, parser_version text NOT NULL, raw_flags bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS measurements_member_time ON measurements(member_id,measured_at DESC);
CREATE INDEX IF NOT EXISTS measurements_device_time ON measurements(device_id,user_slot,measured_at DESC);
CREATE TABLE IF NOT EXISTS blood_pressure (
 measurement_id uuid PRIMARY KEY REFERENCES measurements(id), systolic integer NOT NULL, diastolic integer NOT NULL, pulse integer NOT NULL
);
CREATE TABLE IF NOT EXISTS measurement_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, measurement_id uuid NOT NULL REFERENCES measurements(id), previous jsonb NOT NULL, current jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS receipts (
 collector_id text NOT NULL REFERENCES collectors(id), message_id text NOT NULL, payload_hash text NOT NULL, status text NOT NULL CHECK(status IN('stored','rejected')), error text NOT NULL DEFAULT '', measurement_id uuid REFERENCES measurements(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(collector_id,message_id)
);
CREATE TABLE IF NOT EXISTS rejected_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, collector_id text NOT NULL, message_id text, payload bytea NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, collector_id text NOT NULL REFERENCES collectors(id), command_id uuid, type text NOT NULL, status text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}', error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_command_status_unique ON events(collector_id,command_id,type,status) WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_collector_time ON events(collector_id,created_at DESC);
CREATE TABLE IF NOT EXISTS commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collector_id text NOT NULL REFERENCES collectors(id), type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS firmwares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version text NOT NULL, sha256 text NOT NULL UNIQUE, size bigint NOT NULL, chip text NOT NULL DEFAULT 'esp32c3', partition_layout text NOT NULL DEFAULT 'eir-c3-v1', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ota_jobs (
 id uuid PRIMARY KEY REFERENCES commands(id), collector_id text NOT NULL REFERENCES collectors(id), firmware_id uuid NOT NULL REFERENCES firmwares(id), status text NOT NULL DEFAULT 'pending', error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ota_one_active ON ota_jobs(collector_id) WHERE status IN('pending','downloading','rebooting');

INSERT INTO schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
