# Web O2M Enhanced

**The missing toolbox for Odoo's embedded one2many lists.**

Odoo's one2many lists (order lines, move lines, BoM components, ...) are bare tables:
no search, no export, no quick line operations. This module provides a single drop-in
widget — `one2many_enhanced` — that progressively upgrades the embedded list with the
capabilities users expect from a spreadsheet-like table, without touching the
underlying models or stored data.

> This is **not just a filter widget**. Filtering is the first shipped capability;
> the module's scope is the overall usability of one2many lists (see the
> [roadmap](#roadmap)).

## Usage

Add the widget to any one2many field rendered as a list in a form view:

```xml
<field name="order_line" widget="one2many_enhanced">
    <list editable="bottom">
        <field name="product_id"/>
        <field name="name"/>
        <field name="product_uom_qty"/>
        <field name="price_subtotal" sum="Total"/>
    </list>
</field>
```

Click the filter icon above the table to open the filter row. Press `Escape` in any
filter input to close it and restore the list.

### Widget options

Every tool can be tuned per view through the standard `options` dict:

```xml
<field name="order_line" widget="one2many_enhanced"
       options="{'default_open': True, 'no_filter_columns': ['name'], 'disable_import': True}">
```

| Option                | Type      | Default | Effect                                                            |
| --------------------- | --------- | ------- | ----------------------------------------------------------------- |
| `default_open`        | bool      | `False` | Open the filter bar automatically when the form loads             |
| `disable_filter`      | bool      | `False` | Hide the filter toggle (and never open the filter bar)            |
| `disable_export`      | bool      | `False` | Hide the Excel export button                                      |
| `disable_import`      | bool      | `False` | Hide both the file import and the paste-from-Excel buttons        |
| `disable_bulk_edit`   | bool      | `False` | Hide the bulk edit button (selection stays available)             |
| `disable_duplicate`   | bool      | `False` | Hide the duplicate button (selection stays available)             |
| `disable_selection`   | bool      | `False` | Remove the row checkboxes (also disables bulk edit and duplicate) |
| `disable_hierarchy`   | bool      | `False` | Hide the hierarchy view toggle                                    |
| `hierarchy_field`     | str       | auto    | Self-referencing many2one that defines the tree (auto-detected)   |
| `no_filter_columns`   | list[str] | `[]`    | Field names whose columns get no filter input                     |
| `save_column_widths`  | bool      | `True`  | Persist manual column widths per user                             |

## Current features (19.0.1.5.0)

### Bulk edit

- **Row selection checkboxes** on the embedded list — core Odoo has neither
  selection nor multi-edit inside one2many lists.
- **Filter-aware "select all"**: with an active filter, the header checkbox
  selects only the visible rows. The killer workflow: *filter → select all →
  set a value on every matching line at once*.
- The **bulk edit dialog** lists the editable columns and adapts the value
  input to the column type (number, native date/datetime pickers, selection
  dropdown, boolean checkbox, many2one resolved by name like the import).
  Leaving the value empty clears the field on the selected lines.
- **Many2many (tags) support**: picking a many2many column shows a tag picker
  (search-as-you-type over the related model); the chosen set of tags
  **replaces** the current values on every selected line, and an empty set
  clears them.
- Changes are **staged** like manual edits and applied when the record is
  saved. Bonus: while rows are selected, the footer aggregates show the
  selection's totals (core behaviour, now reachable in o2m lists).

### Hierarchy view

- When the lines have a **many2one field pointing at their own model** (e.g.
  `parent_line_id`), a toolbar toggle displays the list as an **indented tree**
  with expand/collapse carets, ordered depth-first (roots in list order).
- The hierarchy field is **auto-detected** (first self-referencing many2one
  present in the view, including `optional="hide"` columns) or set explicitly
  with the `hierarchy_field` option.
- Plays nicely with filtering: the tree is built from the matching rows, and
  rows whose parent is filtered out are promoted to root level. Collapsing a
  row hides its descendants without affecting the footer totals.

### Persistent column widths

- Column widths resized by dragging the header separators are **remembered and
  restored after a refresh** — per user (browser `localStorage`), per parent
  model and o2m field.
- A **reset button** (visible only when custom widths are stored) restores the
  automatic column layout.
- Saved widths are ignored automatically if the view's column set changes
  (e.g. after a view customization), falling back to the standard layout.

### Line duplication

- **Select one or more lines** and click the duplicate tool in the toolbar. A
  small confirmation dialog asks for the **number of copies per line**
  (default 1, max 50) — one dialog covers both the misclick guard and bulk
  copying.
- Copies include many2many values (e.g. tags); readonly/computed fields are
  recomputed. One2many children are not copied (linking them would re-parent
  the originals).
- Copies are **staged** like manual edits: save the record to apply.

### Excel export & import

- **XLSX export** of the visible rows — respects active filters, so you can filter
  first and export just the matching lines. The file starts with an `ID` column,
  which makes it double as an update template.
- **Import from XLSX / CSV** with two behaviours per row:
  - a row **with an ID** updates the matching line (the round-trip workflow: export,
    edit in Excel, re-import);
  - a row **without an ID** is added as a new line.
- Column headers are matched by label or technical field name; many2one cells are
  resolved by (display) name, selection cells by label or value, booleans accept
  `TRUE/FALSE/1/0/yes/no`, dates use ISO or the user's locale format.
- **Many2many cells** hold comma-separated display names (the export format):
  on import they are resolved by name and **replace** the line's current tags —
  an empty cell clears them on an update. Tag names containing commas cannot be
  matched.
- **Imported changes are staged, not saved**: they land on the form like manual
  edits, so you review them and save the record to apply — or discard to cancel.
- A summary notification reports updated/created counts, ignored columns
  (readonly and one2many columns are not imported) and per-row errors.
- **Paste from Excel**: copy cells in a spreadsheet and paste them straight into
  the list via the toolbar clipboard button — no file needed. The header row is
  auto-detected (overridable with a checkbox); with headers the update-by-ID
  rules apply, without headers cells map to the visible columns in order (new
  lines only). A live preview shows how many lines will be updated/created
  before importing. Dates in the user's locale format are accepted.

### Column filtering suite

- **Per-column filters**, adapted to each column's type:
  - Text: instant "contains" search
  - Number: plain search (matches both the displayed `25,000.00` and the raw
    `25000`), ranges (`0 - 10`, `5 -`, `- 10`) and operators (`>5`, `<=100`, `!=0`)
  - Selection: multi-select checklist (OR semantics); boolean: dropdown
  - Date / datetime: from–to range with the native date picker
  - Many2one / x2many: multi-select checklist of the values in use
- **Cross-page filtering** — every page is loaded so filters search the whole
  recordset; the pager pages through the filtered result.
- **Match highlighting** — the matching text is highlighted live in text and number
  columns (skipped for range/operator conditions, where there is no substring to mark).
- **Live counter & clear-all** — a "shown / total" badge plus a one-click reset of all
  filters.
- **Filtered totals** — footer aggregates (sum/avg/min/max) are recomputed on the
  filtered rows.
- **Edit-safe** — the row being edited or just added never disappears behind an
  active filter.
- **Safety cap** — filtering searches at most the first 1000 records; a warning icon
  is shown when the recordset is larger.

## Roadmap

Planned capabilities, in no particular order:

- Saved filter presets per user

## Known limitations

- Grouped embedded lists are not supported (the filter button is hidden there).
- Client-side filtering/export is capped at the first 1000 records of the recordset.
- Import does not fill one2many or readonly columns; they are reported as ignored.

## Development

- Target version: **Odoo 19** (community image `odoo:19`).
- Client-side OWL components extending `X2ManyField` / `ListRenderer`, plus two
  thin HTTP controllers (XLSX generation via `xlsxwriter`, spreadsheet parsing
  via `openpyxl` — both vendored with Odoo). No models, nothing stored server-side.
- A companion module, `web_o2m_enhanced_demo`, provides a demo model/menu with a
  representative mix of column types for manual testing.

## Support

Questions, bug reports or feature requests: **dmr97.muhammet@gmail.com**

License: see `__manifest__.py`.
