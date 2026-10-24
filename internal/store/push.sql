CREATE TABLE IF NOT EXISTS push_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint text NOT NULL UNIQUE, subscription jsonb NOT NULL,
 token_hash text NOT NULL, member_ids uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 measurement_id uuid NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), next_attempt timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'pending', UNIQUE(subscription_id,measurement_id)
);
CREATE INDEX IF NOT EXISTS push_pending ON push_deliveries(next_attempt) WHERE status='pending';
