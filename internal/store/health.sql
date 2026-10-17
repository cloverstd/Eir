ALTER TABLE members ADD COLUMN IF NOT EXISTS birth_month text NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN IF NOT EXISTS blood_type text NOT NULL DEFAULT '';
UPDATE members SET birth_month=to_char(birth_date,'YYYY-MM') WHERE birth_month='' AND birth_date IS NOT NULL;
CREATE TABLE IF NOT EXISTS health_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('condition','surgery','allergy','medication','family')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), occurred_on date,
 status text NOT NULL DEFAULT 'unknown' CHECK(status IN('active','resolved','unknown')),
 details jsonb NOT NULL DEFAULT '{}', notes text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_history_member ON health_history(member_id,kind,occurred_on DESC);
CREATE TABLE IF NOT EXISTS medical_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 history_id uuid REFERENCES health_history(id) ON DELETE SET NULL,
 title text NOT NULL, category text NOT NULL DEFAULT 'other', recorded_on date, institution text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '',
 filename text NOT NULL, mime_type text NOT NULL, size bigint NOT NULL CHECK(size>0),sha256 text NOT NULL,
 page_count integer NOT NULL CHECK(page_count BETWEEN 1 AND 500), extracted_text text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_member ON medical_documents(member_id,recorded_on DESC);
CREATE TABLE IF NOT EXISTS manual_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('height','weight','body_fat','waist','blood_pressure','heart_rate','blood_glucose','oxygen_saturation','temperature')),
 value numeric NOT NULL,value_secondary numeric,unit text NOT NULL,measured_at timestamptz NOT NULL,
 notes text NOT NULL DEFAULT '',height_snapshot numeric,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_observations_member ON manual_observations(member_id,kind,measured_at DESC);
-- A durable outbox lets file deletion follow a successful database transaction.
CREATE TABLE IF NOT EXISTS document_garbage(id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE VIEW health_observations AS
 SELECT id::text AS id,id AS source_record_id,member_id,kind,value,value_secondary,unit,measured_at,'manual'::text AS source,false AS estimated,false AS age_approximate,notes FROM manual_observations
 UNION ALL SELECT id::text||':blood_pressure',id,member_id,'blood_pressure',systolic::numeric,diastolic::numeric,'mmHg',measured_at,'device',false,false,notes FROM measurement_details WHERE kind='blood_pressure'
 UNION ALL SELECT id::text||':heart_rate',id,member_id,'heart_rate',pulse::numeric,NULL::numeric,'bpm',measured_at,'device',false,false,notes FROM measurement_details WHERE kind='blood_pressure'
 UNION ALL SELECT id::text||':weight',id,member_id,'weight',weight_kg,NULL::numeric,'kg',measured_at,'device',false,false,notes FROM measurement_details WHERE kind='body_composition' AND weight_valid
 UNION ALL SELECT id::text||':body_fat',id,member_id,'body_fat',body_fat_pct,NULL::numeric,'%',measured_at,'device',true,coalesce((profile_snapshot->>'age_approximate')::boolean,false),notes FROM measurement_details WHERE kind='body_composition' AND weight_valid AND body_fat_status='estimated'
 UNION ALL SELECT id::text||':bmi',id,member_id,'bmi',bmi,NULL::numeric,'kg/m²',measured_at,'device',true,coalesce((profile_snapshot->>'age_approximate')::boolean,false),notes FROM measurement_details WHERE kind='body_composition' AND weight_valid AND bmi>0
 UNION ALL SELECT w.id::text||':bmi',w.id,w.member_id,'bmi',round(w.value / power(w.height_snapshot/100,2),2),NULL::numeric,'kg/m²',w.measured_at,'manual',true,false,w.notes FROM manual_observations w WHERE w.kind='weight' AND w.height_snapshot>0;
INSERT INTO schema_versions(version) VALUES(4) ON CONFLICT DO NOTHING;
