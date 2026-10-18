-- Stable, globally unique scale numbers survive sorting, unbinding and
-- deletion of other devices. The sequence is included in normal PG backups.
DO $migration$
DECLARE target record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_versions WHERE version=6) THEN
  CREATE SEQUENCE body_scale_number_seq AS bigint;
  ALTER TABLE devices ADD COLUMN scale_number bigint;
  ALTER SEQUENCE body_scale_number_seq OWNED BY devices.scale_number;
  FOR target IN SELECT id FROM devices WHERE profile='afu-wl-tz-a1' ORDER BY created_at,id LOOP
   UPDATE devices SET scale_number=nextval('body_scale_number_seq') WHERE id=target.id;
  END LOOP;
  CREATE UNIQUE INDEX devices_scale_number_unique ON devices(scale_number) WHERE scale_number IS NOT NULL;
  ALTER TABLE devices ADD CONSTRAINT devices_scale_number_valid CHECK(scale_number IS NULL OR (profile='afu-wl-tz-a1' AND scale_number>0));
  CREATE FUNCTION assign_body_scale_number() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
   IF NEW.profile='afu-wl-tz-a1' THEN
    NEW.scale_number=nextval('body_scale_number_seq');
   ELSE
    NEW.scale_number=NULL;
   END IF;
   RETURN NEW;
  END $function$;
  CREATE TRIGGER devices_assign_scale_number BEFORE INSERT ON devices FOR EACH ROW EXECUTE FUNCTION assign_body_scale_number();
  INSERT INTO schema_versions(version) VALUES(6);
 END IF;
END $migration$;
