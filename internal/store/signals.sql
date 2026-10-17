CREATE TABLE IF NOT EXISTS signal_samples (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 collector_id text NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
 device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
 link_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('wifi','ble')),
 binding_id uuid NOT NULL, data_epoch uuid NOT NULL, boot_id text NOT NULL,
 sequence bigint NOT NULL, sampled_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 rssi smallint, source text NOT NULL CHECK(source IN ('wifi','advertisement','connection')),
 connected boolean NOT NULL,
 UNIQUE(collector_id,binding_id,data_epoch,boot_id,sequence,link_key)
);
CREATE INDEX IF NOT EXISTS signal_samples_link_time ON signal_samples(collector_id,link_key,sampled_at DESC);
CREATE INDEX IF NOT EXISTS signal_samples_expiry ON signal_samples(sampled_at);
CREATE TABLE IF NOT EXISTS signal_latest (
 collector_id text NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
 link_key text NOT NULL,
 sample_id bigint NOT NULL REFERENCES signal_samples(id) ON DELETE CASCADE,
 PRIMARY KEY(collector_id,link_key)
);
INSERT INTO schema_versions(version) VALUES(5) ON CONFLICT DO NOTHING;
