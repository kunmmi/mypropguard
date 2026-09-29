-- Adds what order lifecycle (GET /v1/orders/:id, cancel) needs to look up
-- and act on a real venue order from a reservation: which coin it was for
-- (never persisted before - only reservedAmount was), and the venue's own
-- order id once the authorized action is actually submitted and accepted.
-- Nullable: existing reservations predate this and were never submitted to
-- a venue, so they have no venue order id and no recorded coin.

alter table order_reservations add column coin text;
alter table order_reservations add column venue_order_id text;

create index order_reservations_venue_order_id_idx on order_reservations (venue_order_id) where venue_order_id is not null;
