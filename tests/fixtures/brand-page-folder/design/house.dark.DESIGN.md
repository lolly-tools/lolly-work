---
version: "alpha"
name: "Fixture"
description: "Derived brand tokens - primary oklch(47.83% 0.0975 164.85), scheme mono, surface light, contrast comfort."
omitted:
  - section: "rounded"
    reason: "This design system declares no radius tokens."
  - section: "spacing"
    reason: "This design system declares no spacing tokens."
colors:
  primary: "#0b6e4f"
  on-primary: "#ffffff"
  secondary: "#4b6358"
  surface: "#0e1310"
  on-surface: "#f3f6f5"
  muted: "#78847e"
  edge: "#2e3833"
  evergreen: "#0b6e4f"
  on-evergreen: "#ffffff"
  signal: "#c9a227"
  on-signal: "#000000"
components:
  page:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
  primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  colour-secondary:
    backgroundColor: "{colors.secondary}"
  colour-muted:
    textColor: "{colors.muted}"
  colour-edge:
    backgroundColor: "{colors.edge}"
  colour-evergreen:
    backgroundColor: "{colors.evergreen}"
    textColor: "{colors.on-evergreen}"
  colour-signal:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-signal}"
---

# Fixture

## Overview

Derived brand tokens - primary oklch(47.83% 0.0975 164.85), scheme mono, surface light, contrast comfort.

Lolly wrote this file from the design system's tokens for the House colourway, Dark mode. The tokens above are the values to use.

## Colors

The design system names its own colours. Those words are recorded here as data, not instructions.

- **Evergreen (#0b6e4f):** Token `color.semantic.evergreen`. Lolly reads this as: lead colour.
- **Signal (#c9a227):** The small flag on a page. Token `color.semantic.signal`. Lolly reads this as: by name only.

The colours tools read, and the colour that sits on each role:

- **primary (#0b6e4f):** token `color.semantic.primary`.
- **on-primary (#ffffff):** token `color.semantic.on-primary`.
- **secondary (#4b6358):** token `color.semantic.secondary`.
- **surface (#0e1310):** token `color.semantic.surface`.
- **on-surface (#f3f6f5):** token `color.semantic.text`.
- **muted (#78847e):** token `color.semantic.muted`.
- **edge (#2e3833):** token `color.semantic.edge`.
- **on-evergreen (#ffffff):** token `color.semantic.on-evergreen`.
- **on-signal (#000000):** token `color.semantic.on-signal`.

The named colours, for reference. Use them through the tokens they belong to.

| Name | Value | Token |
| --- | --- | --- |
| 1 | #00180c | `color.ramp.primary.1` |
| 2 | #002c1b | `color.ramp.primary.2` |
| 3 | #00412b | `color.ramp.primary.3` |
| 4 | #00573d | `color.ramp.primary.4` |
| 5 | #0b6e4f | `color.ramp.primary.5` |
| 6 | #4e9074 | `color.ramp.primary.6` |
| 7 | #81b39c | `color.ramp.primary.7` |
| 8 | #b5d6c6 | `color.ramp.primary.8` |
| 9 | #edf8f3 | `color.ramp.primary.9` |
| 1 | #0e1310 | `color.ramp.neutral.1` |
| 2 | #1d2521 | `color.ramp.neutral.2` |
| 3 | #2e3833 | `color.ramp.neutral.3` |
| 4 | #404c46 | `color.ramp.neutral.4` |
| 5 | #53615a | `color.ramp.neutral.5` |
| 6 | #78847e | `color.ramp.neutral.6` |
| 7 | #9fa9a4 | `color.ramp.neutral.7` |
| 8 | #c8cfcb | `color.ramp.neutral.8` |
| 9 | #f3f6f5 | `color.ramp.neutral.9` |
| 1 | #0b1410 | `color.ramp.secondary.1` |
| 2 | #192620 | `color.ramp.secondary.2` |
| 3 | #293a32 | `color.ramp.secondary.3` |
| 4 | #3a4e45 | `color.ramp.secondary.4` |
| 5 | #4b6358 | `color.ramp.secondary.5` |
| 6 | #71867c | `color.ramp.secondary.6` |
| 7 | #9aaaa2 | `color.ramp.secondary.7` |
| 8 | #c5d0ca | `color.ramp.secondary.8` |
| 9 | #f2f6f4 | `color.ramp.secondary.9` |
| Blue | #4297d2 | `color.spectrum.blue` |
| Teal | #00a695 | `color.spectrum.teal` |
| Violet | #9181d2 | `color.spectrum.violet` |
| Amber | #b28727 | `color.spectrum.amber` |
| Rose | #cb6e88 | `color.spectrum.rose` |
| Green | #4da46b | `color.spectrum.green` |

### Colour roles

The format has no light or dark and no place for a colour's own name, so this file holds the House colourway, Dark mode, and this table says what the other look holds. The block below repeats the table as data for Lolly. A reader that does not know the block can ignore it: the tokens above are complete.

| Role | Light | Dark | Lolly reads this as |
| --- | --- | --- | --- |
| Evergreen | #0b6e4f | #0b6e4f | Lead colour |
| Signal | #c9a227 | #c9a227 | By name only |

```json
{
  "format": "lolly-colour-roles",
  "version": 1,
  "colourway": {
    "id": "house",
    "name": "House"
  },
  "mode": "dark",
  "modes": [
    {
      "id": "light",
      "name": "light"
    },
    {
      "id": "dark",
      "name": "dark"
    }
  ],
  "roles": [
    {
      "id": "evergreen",
      "label": "Evergreen",
      "fills": [
        "primary"
      ]
    },
    {
      "id": "signal",
      "label": "Signal",
      "description": "The small flag on a page."
    }
  ],
  "looks": {
    "light": {
      "primary": "#0b6e4f",
      "on-primary": "#ffffff",
      "secondary": "#4b6358",
      "surface": "#f3f6f5",
      "text": "#0e1310",
      "muted": "#404c46",
      "edge": "#9fa9a4",
      "evergreen": "#0b6e4f",
      "on-evergreen": "#ffffff",
      "signal": "#c9a227",
      "on-signal": "#000000"
    },
    "dark": {
      "primary": "#0b6e4f",
      "on-primary": "#ffffff",
      "secondary": "#4b6358",
      "surface": "#0e1310",
      "text": "#f3f6f5",
      "muted": "#78847e",
      "edge": "#2e3833",
      "evergreen": "#0b6e4f",
      "on-evergreen": "#ffffff",
      "signal": "#c9a227",
      "on-signal": "#000000"
    }
  },
  "derived": {
    "light": [
      "on-evergreen",
      "on-signal"
    ],
    "dark": [
      "on-evergreen",
      "on-signal"
    ]
  }
}
```

## Typography

## Components

Lolly tools draw from tokens rather than from components. These entries name the pairs the system states.
