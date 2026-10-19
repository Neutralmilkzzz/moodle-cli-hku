---
name: hku-cli
description: HKU Moodle, forwarded mail and Library booking from the terminal.
---

# HKU CLI

Moodle commands use `hku` or `moodle`; only `submit` writes. UNIT is a code/name/id/URL.

| Intent | Run |
| --- | --- |
| dashboard | moodle |
| deadlines | moodle due [UNIT] --days 14 |
| unit names | moodle units |
| a unit or section | moodle UNIT [SECTION] |
| find slides or a task | moodle find "QUERY" [UNIT] |
| submission or item detail | moodle UNIT "TASK" |
| a quiz attempt | moodle attempt ID |
| grades | moodle grades [UNIT] |
| announcements | moodle news [UNIT] |
| forum post text | moodle forums search "QUERY" --unit UNIT |
| upload assignment files | moodle submit "UNIT TASK" FILE... [--final] |
| download a file | moodle dl "UNIT TASK" --to DIR |

Mail: `hku mail inbox [QUERY]`; `read ID`; send with `--dry-run`, then `--yes`.
Library: `hku library slots`; `book --room ROOM --start HH:mm --end HH:mm --dry-run`.
JSON in pipes; `--json` forces it. Ambiguity returns `candidates`; never guess.
Never expose cookies/tokens. Dry-run writes; `--final` and `--yes` cannot be undone.
Syntax: `hku commands --json`. [Commands](references/command-reference.md) · [Setup](references/setup-and-auth.md).
