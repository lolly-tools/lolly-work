-- The history across documents (plan 221, GET /api/v1/history) reads versions
-- of many documents newest first and stops at the end of a page. This index has
-- that order, so a page reads about as many rows as it shows instead of every
-- version of every document in scope.
create index session_versions_history on session_versions (at desc, id collate "C" desc);
