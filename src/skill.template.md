{{generated_frontmatter}}

# HKU CLI

Moodle commands use `hku` or `moodle`; only `submit` writes. UNIT is a code/name/id/URL.

{{generated_intent_table}}

Mail: `hku mail inbox [QUERY]`; `read ID`; send with `--dry-run`, then `--yes`.
Library: `hku library slots`; `book --room ROOM --start HH:mm --end HH:mm --dry-run`.
JSON in pipes; `--json` forces it. Ambiguity returns `candidates`; never guess.
Never expose cookies/tokens. Dry-run writes; `--final` and `--yes` cannot be undone.
Syntax: `hku commands --json`. [Commands](references/command-reference.md) · [Setup](references/setup-and-auth.md).
