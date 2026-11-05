-- SPDX-License-Identifier: MPL-2.0
-- Scopes on service tokens. Null means the token keeps its role's full reach, so
-- every existing token behaves as before. Both lists are fixed when the token is
-- minted; the route table in server/src/iam/token-scopes.ts gives scopes meaning.
alter table api_tokens add column scopes text[];
alter table api_tokens add column tools text[];
