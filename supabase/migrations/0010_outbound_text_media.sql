-- The contact card that rides along with a first text.
--
-- Resolved at ARM time and stored, not resolved at send time. The URL is a
-- Sendblue CDN link produced by uploading the vCard, and re-deriving it in the
-- cron would mean the attachment his friend receives was chosen after he
-- approved — the same reason the message body is frozen in the row next door.
-- Storing it also makes the send a pure replay: to_number, body, media_url.
alter table outbound_texts add column media_url text;
