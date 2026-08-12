# Roles and grants

Two layers, one evaluator:

![Fine-grained grants — per-group allow/deny layered on the role defaults, deny-wins](shots/permissions-grants.svg)

1. **A small fixed role set**, derived from group membership.
2. **Fine-grained grants** — `(principal, action, resource, effect)` rows that override the
   role default in either direction.

Evaluation order is fixed and pure: **any matching deny wins → any matching allow →
the role default**. `server/src/rbac/evaluate.ts` is the whole thing, and it never looks
anything up: a resource arrives as the set of selectors it satisfies (e.g.
`['tool:event-badge', 'tool:tag/external-facing', '*']`).

## Roles

| Role | Comes from | Carries |
|---|---|---|
| `viewer` | assigned | `catalog.read`, `session.view` |
| `member` | the default for any signed-in user | viewer + `tool.use`, `session.create/edit/delete/share`, `project.create`, `export.download`, `export.request`, `link.create` |
| `author` | group `author` | member + `catalog.submit` |
| `approver` | group `approver` | member + `approval.act` |
| `admin` | group `admin` | author ∪ approver + `catalog.publish`, `catalog.expire`, `catalog.provider.read`, `catalog.provider.manage`, `policy.edit`, `grant.edit`, `link.revoke`, `link.create-guest`, `message.send`, `telemetry.view`, `fleet.view`, `audit.export`, `project.manage`, `project.archive`, `approval.assign`, `export.server` |
| `owner` | group `owner` | admin + `instance.config`, `catalog.provider.credential` |
| `guest` | a guest-edit link | **nothing** — access is entirely link-scoped grants |

Role comes from the effective group set (IdP ∪ local groups): the highest of `owner`,
`admin`, `approver`, `author`, else `member`. See [identity](identity.md).

Two actions stay **owner-only** on purpose: an admin can shape a catalog provider, but only
an owner puts a credential in it or flips its kill switch, and only an owner changes deploy
config.

## Grants

```bash
lw grants list
lw grants add group:brand policy.edit '*'            --effect allow
lw grants add group:contractors export.download 'tool:price-card' --effect deny
lw grants rm  group:brand policy.edit '*'
```

Also `GET/POST/DELETE /api/v1/grants` and the console's **Grants** view. All three are the
same API — the console and CLI grow in parity by construction.

| Field | Form |
|---|---|
| `principal` | `group:<name>`, `user:<id>`, or `*` |
| `action` | any action id from the table above |
| `resource` | a selector — `*`, `tool:<id>`, `tool:tag/<tag>`, `catalog:tag/<tag>`, … |
| `effect` | `allow` or `deny` |

Grants take effect on the **next request** — there is no cache to bust and no restart.
Every mutation is audited.

### The escalation guard

A grant that creates or removes `instance.config` or `catalog.provider.credential` requires
the **owner** role, even though grant editing itself is an admin action. Without it, an
admin could mint themselves owner powers. Attempting it returns
`403 OWNER_ONLY_ACTION`.

### "Edit but not export"

This is the canonical fine-grained ask, and it is two rows:

```bash
lw grants add group:contractors tool.use        'tool:campaign-banner' --effect allow
lw grants add group:contractors export.download 'tool:campaign-banner' --effect deny
```

Deny wins, so the contractor can work in the tool and cannot take the file out. Tag
selectors let the same pair cover a whole class of tools (`tool:tag/external-facing`)
rather than enumerating ids.

### Explicit allow vs role default

Some decisions must distinguish "an explicit grant allows this" from "the caller's role
happens to allow this" — tool visibility is the example: the `member` default of `tool.use`
would otherwise un-hide every governed tool. Those callers use the explicit-grant decision
(`grantDecision`), which returns `allow` / `deny` / `none`. It matters when you are
reasoning about why a tool is or is not visible.

## Guest write authority

A guest is never evaluated by the grants engine **as a principal**: `server/src/collab/guests.ts`
imports nothing from `rbac/`, on purpose. A guest's ability to write in a live collab room comes
from the **kind** of the link that admitted it — `guest-edit` mints a writer seat, every other
link kind mints no guest principal — never from a grant row naming the guest.

That asymmetry is easy to trip over. A grant like

```bash
lw grants add '*' session.edit '*' --effect deny
```

silences every **member's** write access in a live room (`mayEditCollab` calls `evaluate()`,
which this grant matches for any principal) — and reaches no guest, because a guest's
writer/observer split never runs `evaluate()` against the guest. `session.edit`, `collab.join`,
a role change, a group removal — evaluated against the guest's own principal, none of it decides
anything, because nothing evaluates that principal.

**One action is the exception, and it is the one that matters: `link.create-guest`, evaluated
against the INVITER.** The gateway re-checks the inviter's standing on every gesture and every
keepalive (`guestInviterStanding` → `mayCreateGuestLinks` → `evaluate()`, gateway.ts), so an
inviter who loses that action stops minting links *and* loses the guests already holding them.
Offboarding an inviter is therefore a live eviction, not a change that takes effect at the next
mint.

Four levers, then — three that act on the guest, one that acts on the inviter:

| Lever | Effect |
|---|---|
| An `inputAccess` rule ([governance](governance.md#per-input-access)) | Locks, hides or choice-restricts one input for every guest, in every room, without naming anyone. See the fallback below — it reaches a guest whether or not the rule names one. |
| Revoking the link (`POST /api/v1/links/:id/revoke`) | Kills that guest's write access on its very next gesture — the room re-reads the link per gesture and per keepalive, the same cadence a member's grant revocation lands on. |
| `guestLinks.enabled: false` ([configuration](configuration.md)) | The instance-wide kill switch. Stops new links from minting *and* evicts every guest already connected — re-checked live, not only at mint time. |
| Taking `link.create-guest` off the **inviter** — a deny grant, a role change, removing them from the group that carried it, or disabling the account | Evicts every guest **that inviter** admitted, on the guest's next op or keepalive. The one lever that covers links nobody can enumerate; it leaves guests invited by anyone else alone. |

The `inputAccess` lever is one-way, and not in the direction the group names suggest. A guest
carries only the synthetic `guests` group, so a rule written for a tool's real editing groups
(`'team-eng'`, `'admin'`, …) matches no guest — and a guest that matches no rule on a **governed**
input does not inherit the member-side `editable` fallback: the gateway locks it
(`vetoOps` + `inputIsGoverned`, `INPUT_LOCKED`). So governing an input at all narrows it for
guests, and nothing widens it back: even `{"groups": ["guests"], "level": "editable"}` resolves to
locked in a live room, because the guest fallback is applied after resolution. An input with **no**
rules at all is untouched and stays editable for everyone, guests included.

What is not a lever: a grant naming the guest, and any action other than `link.create-guest`.
Those never reach the path a guest's write decision takes.

## Checking your work

Never guess what a person will see — ask the same assembler the live client polls:

```bash
lw preview --groups marketing,contractors
```

or the console's **Preview** view, or `GET /api/v1/org-config/preview?groups=…`. It reports
the resolved role, permissions, tool visibility, per-input governance and profile policy for
that group set. Because it runs through the production code path, it cannot drift from what
the member actually receives.

## Related

- Locking individual tool inputs, not just whole tools: [governance](governance.md)
- Who can approve what: [approvals](approvals.md)
- Exporting the whole grant set as code: [governance](governance.md)
- Every action's route: [api](api.md)
