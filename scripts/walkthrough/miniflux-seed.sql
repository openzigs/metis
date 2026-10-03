-- Miniflux v2.3.3 seed for the #706 end-to-end walkthrough (Issue #823).
--
-- Why SQL: `miniflux -create-admin` refuses to run without a TTY, so an agent
-- cannot create the admin user through the binary. This seed writes the rows
-- the walkthrough needs directly, AFTER `miniflux -migrate` has built the
-- schema (schema version 132 at v2.3.3).
--
-- Shape: 1 user (mfadmin), 1 category (Tech), 1 feed (The Go Blog) and
-- 25 entries. Every 3rd entry is `read`, every 5th is starred; `changed_at`
-- is always set because the column is NOT NULL. Expected: 8 read / 17 unread,
-- 5 starred.
--
-- Idempotent: every insert is guarded by the table's natural unique key
-- (users.username, categories(user_id, title), feeds(user_id, feed_url),
-- entries(feed_id, hash)) with ON CONFLICT DO NOTHING, so a second run is a
-- no-op. Timestamps are fixed rather than now()-relative, so every walkthrough
-- run sees identical data.
--
-- The password is a deliberate placeholder, NOT a bcrypt hash: nobody can log
-- in to Miniflux as mfadmin. The walkthrough reads these rows only through
-- METIS's database connector; it never uses the Miniflux UI.
--
-- Apply:
--   docker exec -i mf-pg psql -v ON_ERROR_STOP=1 -U postgres -d miniflux \
--     < scripts/walkthrough/miniflux-seed.sql

BEGIN;

INSERT INTO users (username, password, is_admin)
VALUES ('mfadmin', 'PLACEHOLDER-NOT-A-BCRYPT-HASH', true)
ON CONFLICT (username) DO NOTHING;

INSERT INTO categories (user_id, title)
SELECT u.id, 'Tech'
FROM users u
WHERE u.username = 'mfadmin'
ON CONFLICT (user_id, title) DO NOTHING;

INSERT INTO feeds (user_id, category_id, title, feed_url, site_url, checked_at, next_check_at)
SELECT u.id, c.id, 'The Go Blog', 'https://go.dev/blog/feed.atom', 'https://go.dev/blog',
       TIMESTAMPTZ '2026-10-01 00:00:00+00', TIMESTAMPTZ '2026-10-01 01:00:00+00'
FROM users u
JOIN categories c ON c.user_id = u.id AND c.title = 'Tech'
WHERE u.username = 'mfadmin'
ON CONFLICT (user_id, feed_url) DO NOTHING;

INSERT INTO entries (user_id, feed_id, hash, published_at, changed_at, title, url,
                     author, content, status, starred)
SELECT u.id,
       f.id,
       md5('walkthrough-823-go-blog-entry-' || n),
       TIMESTAMPTZ '2026-09-01 12:00:00+00' + make_interval(days => n),
       TIMESTAMPTZ '2026-09-01 13:00:00+00' + make_interval(days => n),
       'The Go Blog post #' || n,
       'https://go.dev/blog/walkthrough-seed-' || n,
       'The Go Team',
       '<p>Seeded entry ' || n || ' for the METIS #706 walkthrough.</p>',
       (CASE WHEN n % 3 = 0 THEN 'read' ELSE 'unread' END)::entry_status,
       (n % 5 = 0)
FROM generate_series(1, 25) AS n
JOIN users u ON u.username = 'mfadmin'
JOIN feeds f ON f.user_id = u.id AND f.feed_url = 'https://go.dev/blog/feed.atom'
ON CONFLICT (feed_id, hash) DO NOTHING;

COMMIT;
