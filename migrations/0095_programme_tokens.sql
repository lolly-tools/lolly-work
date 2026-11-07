-- SPDX-License-Identifier: MPL-2.0
-- Tokens a programme's manager mints (plans/82 M7). `via` is 'programme' for a
-- token minted for one programme: it never leaves that programme and is revoked
-- rather than moved. Null for a token an owner minted, so every existing token
-- behaves as before. Dropping the column lets an owner move such a token out of
-- its programme again.
alter table api_tokens add column via text;
