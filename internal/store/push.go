package store

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func enqueuePush(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `INSERT INTO push_deliveries(subscription_id,measurement_id,member_id,next_attempt)
 SELECT s.id,m.id,m.member_id,now()+CASE WHEN m.kind='body_composition' THEN interval '10 seconds' ELSE interval '0 seconds' END
 FROM measurements m JOIN push_subscriptions s ON m.member_id=ANY(s.member_ids) WHERE m.id=$1 ON CONFLICT DO NOTHING`, id)
	return err
}
