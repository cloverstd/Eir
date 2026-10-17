DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_versions WHERE version=3) THEN
 ALTER TABLE members ADD COLUMN sex text NOT NULL DEFAULT '' CHECK(sex IN('','male','female')),
 ADD COLUMN height_cm numeric CHECK(height_cm BETWEEN 50 AND 250), ADD COLUMN birth_date date;
 ALTER TABLE devices ADD COLUMN hardware_id text NOT NULL DEFAULT '',
 ADD COLUMN adc_index integer NOT NULL DEFAULT 0 CHECK(adc_index IN(0,1));
 ALTER TABLE bindings DROP CONSTRAINT bindings_user_slot_check;
 ALTER TABLE bindings ADD CONSTRAINT bindings_user_slot_check CHECK(user_slot IN(0,1,2));
 ALTER TABLE measurements DROP CONSTRAINT measurements_user_slot_check;
 ALTER TABLE measurements ADD CONSTRAINT measurements_user_slot_check CHECK(user_slot IN(0,1,2));
 ALTER TABLE measurements ALTER COLUMN record_sequence DROP NOT NULL;
 ALTER TABLE measurements ADD COLUMN time_source text NOT NULL DEFAULT 'device';
 INSERT INTO schema_versions(version) VALUES(3);
END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS devices_hardware_unique ON devices(profile,hardware_id) WHERE hardware_id<>'';
CREATE UNIQUE INDEX IF NOT EXISTS bindings_one_current ON bindings(device_id,user_slot) WHERE effective_to IS NULL;
CREATE TABLE IF NOT EXISTS body_composition(
 measurement_id uuid PRIMARY KEY REFERENCES measurements(id), measurement_session_id text NOT NULL,
 weight_grams integer NOT NULL CHECK(weight_grams BETWEEN 1000 AND 300000),
 raw_adcs jsonb NOT NULL DEFAULT '[]', impedance_raw bytea,
 adc_index integer NOT NULL CHECK(adc_index IN(0,1)),
 resistance numeric NOT NULL DEFAULT 0, bmi numeric NOT NULL DEFAULT 0,
 body_fat_pct numeric NOT NULL DEFAULT 0, body_fat_status text NOT NULL DEFAULT 'missing_adc',
 profile_snapshot jsonb NOT NULL DEFAULT '{}', algorithm_version text NOT NULL DEFAULT ''
);
-- Append columns so existing view consumers retain their original column order.
CREATE OR REPLACE VIEW measurement_details AS
 SELECT m.id,m.member_id,p.name AS member_name,m.device_id,coalesce(d.name,m.source_device_name,'已移除设备') AS device_name,coalesce(m.collector_id,m.source_collector_id) AS collector_id,m.user_slot,m.kind,m.record_sequence,m.measured_at,m.device_time,m.measured_at IS NOT NULL AS time_valid,m.received_at,m.timezone,m.notes,m.manual_assignment,encode(m.raw_data,'hex') AS raw_hex,m.parser_version,b.systolic,b.diastolic,b.pulse,
 m.time_source,c.measurement_session_id,c.weight_grams,c.weight_grams/1000.0 AS weight_kg,c.raw_adcs,encode(c.impedance_raw,'hex') AS impedance_raw_hex,c.adc_index,c.resistance,c.bmi,c.body_fat_pct,c.body_fat_status,c.profile_snapshot,c.algorithm_version,
 CASE WHEN m.kind<>'body_composition' THEN true WHEN octet_length(m.raw_data)=20 THEN (get_byte(m.raw_data,2)&128)<>0 AND get_byte(m.raw_data,6)=2 ELSE false END AS weight_valid
 FROM measurements m LEFT JOIN devices d ON d.id=m.device_id LEFT JOIN members p ON p.id=m.member_id LEFT JOIN blood_pressure b ON b.measurement_id=m.id LEFT JOIN body_composition c ON c.measurement_id=m.id;
