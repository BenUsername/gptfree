-- Per-IP daily message cap for anonymous (not signed in) chat requests.
-- Only a salted hash of the caller's IP is stored, never the raw address.

CREATE TABLE IF NOT EXISTS gptfree_anon_usage (
  ip_hash TEXT NOT NULL,
  day DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ip_hash, day)
);

CREATE INDEX IF NOT EXISTS idx_gptfree_anon_usage_day ON gptfree_anon_usage(day);

ALTER TABLE gptfree_anon_usage ENABLE ROW LEVEL SECURITY;

-- Atomic increment: one round trip, no read-modify-write race between
-- concurrent requests from the same IP. Returns the new count for the day.
CREATE OR REPLACE FUNCTION gptfree_bump_anon_usage(p_ip_hash TEXT, p_day DATE)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO gptfree_anon_usage (ip_hash, day, count)
  VALUES (p_ip_hash, p_day, 1)
  ON CONFLICT (ip_hash, day) DO UPDATE
    SET count = gptfree_anon_usage.count + 1,
        updated_at = now()
  RETURNING count;
$$;

COMMENT ON TABLE gptfree_anon_usage IS
  'Daily anonymous message counters keyed by a salted hash of the client IP';
COMMENT ON FUNCTION gptfree_bump_anon_usage(TEXT, DATE) IS
  'Atomically increments and returns today''s anonymous message count for an IP hash';
