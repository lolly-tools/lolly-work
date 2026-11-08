-- SPDX-License-Identifier: MPL-2.0
-- The company's kit pointer sits beside its settings. Kit revisions belong
-- to the instance asset, so profile history keeps no copy of the pointer.
alter table partner_company_profiles add column kit jsonb;
