-- SPDX-License-Identifier: MPL-2.0
-- Programme and company groups on service tokens (plans/82 M3, the first slice
-- of M7 item 3). A token placed in a partner programme, and optionally in one
-- company inside it, resolves to a principal carrying those groups, so it is
-- scoped exactly like a person in that programme: the same tools, assets, input
-- rules and company values. Null means the token carries no groups, so every
-- existing token behaves as before. Dropping the column returns every token to
-- that state; a token that was placed in a programme would then reach its
-- role's full reach again, so revoke such tokens before dropping it.
alter table api_tokens add column groups text[];
