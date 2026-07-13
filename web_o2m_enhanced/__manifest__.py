{
    'name': 'One2many Filter, Search, Bulk Edit & Excel Import/Export | Enhanced O2M List Widget',
    'version': '18.0.1.17.10',
    'category': 'Productivity',
    'author': 'Meisanqo',
    'support': 'meisanqo@outlook.com',
    'summary': 'Filter, search, bulk edit and mass update one2many lines. Excel/XLSX import, export and copy-paste from spreadsheets. Duplicate lines, saved column widths, tree view. Works on any one2many list in a form view.',
    'description': """
The missing toolbox for Odoo's embedded one2many lists.

Adds a single drop-in field widget, `one2many_enhanced`, usable on any
one2many field rendered as a list view. Its scope is the overall usability of
embedded lists: it progressively upgrades them with the capabilities users
expect from a spreadsheet-like table, without touching the underlying models
or stored data.

Available now — column filtering suite:

- Per-column filter row: text, number (raw and formatted values, ranges and
  >,<,>=,<=,!=,= operators), selection (multi-select), boolean, date range
  (with picker) and many2one/x2many multi-select filters, combined with AND
  semantics across columns (OR within a multi-select).
- Cross-page filtering: every page is loaded so filters search the whole
  recordset, with the pager working on the filtered result.
- Live highlighting of the matching text in text and number columns.
- Record counter ("shown / total") and a one-click "clear all filters" button.
- Footer aggregates (sum/avg/min/max) are recomputed on the filtered rows.
- The row being edited or just added always stays visible while filtering.
- A warning is shown when the recordset exceeds the 1000-record client-side
  filtering cap.

Excel export & import:

- One-click XLSX export of the visible (filtered) rows, with a leading ID
  column so the file doubles as an update template.
- Import from XLSX or CSV: rows with an ID update the matching line, rows
  without an ID are added as new lines. Many2one cells are resolved by name,
  selection cells by label or value, many2many cells as comma-separated names
  (replacing the line's current tags). When several records share the same
  name, an "[ID]" suffix in the cell (e.g. "John Smith [42]") picks one
  explicitly — the row error lists the candidates with their IDs.
- Imported changes are staged on the form like manual edits: review them and
  save the record to apply, or discard to cancel. A summary notification
  reports updated/created counts and any row errors.
- Paste from Excel: copy cells in a spreadsheet and paste them straight into
  the list (toolbar button). The header row is auto-detected (overridable);
  with headers the update-by-ID rules apply, without headers the cells map to
  the visible columns in order. A live preview shows how many lines will be
  updated/created before importing. Dates in the user's locale format are
  accepted.

Line duplication:

- Select one or more lines and use the duplicate tool in the toolbar: a
  confirmation dialog asks how many copies of each selected line to create.
- Copies include tags (many2many values); computed fields are recomputed.
- Copies are staged on the form like manual edits and applied on save.

Bulk edit:

- Row selection checkboxes on the embedded list (core Odoo has neither
  selection nor multi-edit inside one2many lists).
- With an active filter, "select all" selects only the visible (filtered)
  rows: filter, select all, set a value on every matching line at once.
- The bulk edit dialog offers the list's editable columns and a value input
  adapted to the column type (number, date pickers, selection dropdown,
  boolean, many2one resolved by name, many2many as a tag picker whose chosen
  tags replace the lines' current values). Leaving the value empty clears the
  field. Changes are staged on the form and applied on save.
- While rows are selected, the footer aggregates show the selection's totals.

Persistent column widths:

- Column widths resized by dragging the header separators are remembered per
  user (browser storage) and restored after a refresh, per model and field.
- A "reset column widths" button restores the automatic layout.

Hierarchy view:

- When the lines have a many2one field pointing at their own model (e.g. a
  parent line), a toolbar toggle displays the list as an indented tree with
  expand/collapse carets, ordered depth-first. The field is auto-detected or
  set explicitly via the hierarchy_field option.
- Works together with filtering: the tree is built from the matching rows,
  and rows whose parent is filtered out are promoted to root level.

Per-view widget options:

- Every tool can be tuned per view via the field's options dict: default_open,
  disable_filter, disable_export, disable_import, disable_bulk_edit,
  disable_duplicate, disable_selection, disable_hierarchy, hierarchy_field,
  no_filter_columns, save_column_widths.

No-code setup from the UI:

- Settings > Technical > User Interface > Enhanced Tables: pick a model and
  the table (one2many field), choose the options, and every form view
  displaying that table gets the enhanced widget — no view XML needed. The
  forms refresh right after saving the setup.
- Managing the setups is reserved to the "Enhanced Tables / Manager" access
  right (granted to administrators out of the box, assignable to any user
  from the Users form).
- Options written in the view XML keep precedence over the UI setup. Tables
  displayed with a custom widget (e.g. sale order lines' sections widget) are
  left untouched by default — the setup form warns you when that is the case
  and offers an explicit "Override Custom Widget" switch (off by default) to
  replace the custom widget anyway.

Safety:

- Read-only is always respected: columns read-only on the model or in the
  view (including record-dependent readonly expressions) are never modified
  by bulk edit, import, paste or duplication, and no tool can add lines when
  the list does not allow creation or stage edits when the field is read-only.

Known limitations:

- Grouped embedded lists are not supported (the filter button is hidden).
- Filtering searches at most the first 1000 records of the recordset.

Usage: add widget="one2many_enhanced" to a one2many <field> tag in a form view.
""",
    'depends': ['web'],
    'images': ['static/description/banner.png'],
    'data': [
        'security/o2m_enhanced_security.xml',
        'security/ir.model.access.csv',
        'views/o2m_enhanced_config_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'web_o2m_enhanced/static/src/**/*',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'OPL-1',
    'price': 79.0,
    'currency': 'EUR',
}
