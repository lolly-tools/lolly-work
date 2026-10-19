-- The history across documents (plan 221, GET /api/v1/history) reads versions
-- of many documents newest first and stops at the end of a page. This index has
-- that order, so a page starts at its position (the store bounds `at` by it) and
-- stops once it is full, instead of reading every version of every document in
-- scope. Versions in projects outside the scope that fall between are still read
-- and passed over.
create index session_versions_history on session_versions (at desc, id collate "C" desc);
