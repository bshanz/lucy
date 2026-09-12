-- The memory slot (agent/memory.ts) reads the newest memories before every
-- owner turn, so newest-first is now the hot path rather than an occasional
-- tool call.
create index if not exists memories_created_at_idx on memories (created_at desc);
