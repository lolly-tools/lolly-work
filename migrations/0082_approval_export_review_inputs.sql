-- SPDX-License-Identifier: MPL-2.0
-- Finds export reviews by the digest of their reported inputs without reading the
-- rest of the approvals table. A server render of a tool set to `until-approved`
-- asks this on every render, and a person's export bar asks when their inputs change.
create index approvals_export_review_inputs on approvals ((doc->'exportReview'->>'inputsDigest'))
  where doc->'exportReview'->>'inputsDigest' is not null;
