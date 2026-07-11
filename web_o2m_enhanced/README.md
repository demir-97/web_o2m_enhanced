# Web O2M Enhanced

**The missing toolbox for Odoo's embedded one2many lists.**

Odoo's one2many lists (order lines, move lines, BoM components, ...) are bare tables:
no search, no export, no quick line operations. This module provides a single drop-in
widget — `one2many_enhanced` — that upgrades the embedded list with the capabilities
users expect from a spreadsheet-like table: Excel-like filters, bulk edit, XLSX
export & import, paste from Excel, line duplication, hierarchy view and persistent
column widths.

It is a pure client-side widget: no model changes, no stored data, nothing written
behind your back.

## Getting started

### From the UI (recommended, no code)

Open **Settings › Technical › User Interface › Enhanced Tables**, create a setup,
pick the model and one of its one2many tables, choose the tools you want and save —
every form view displaying that table gets the enhanced widget instantly. No view
XML, no code change needed.

- All options are available in the setup form: open filters by default, remember
  column widths, disable any individual tool, pin the hierarchy field, exclude
  columns from filtering.
- If a table already uses a specialized widget (like the sale order lines'
  sections & notes), the setup warns you and leaves it untouched, unless you
  explicitly enable *Override Custom Widget*.
- Managing the setups is reserved to the *Enhanced Tables / Manager* access right
  (granted to administrators out of the box).

### Or in the view XML

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

Every tool can be tuned per view through the standard `options` dict (options
written in the XML keep precedence over the UI setup):

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

## Features

### Column filtering suite

- **Per-column filters**, adapted to each column's type:
  - Text: instant "contains" search
  - Number: plain search (matches both the displayed `25,000.00` and the raw
    `25000`), ranges (`0 - 10`, `5 -`, `- 10`) and operators (`>5`, `<=100`, `!=0`)
  - Selection: multi-select checklist; boolean: dropdown
  - Date / datetime: from–to range with the native date picker
  - Many2one / x2many: multi-select checklist of the values in use
- **Cross-page filtering** — every page is loaded so filters search the whole
  recordset; the pager pages through the filtered result.
- **Match highlighting** — the matching text is highlighted live in text and number
  columns as you type.
- **Live counter & clear-all** — a "shown / total" badge plus a one-click reset of all
  filters.
- **Filtered totals** — footer aggregates (sum/avg/min/max) are recomputed on the
  filtered rows.
- **Edit-safe** — the row being edited or just added never disappears behind an
  active filter.

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
  an empty cell clears them on an update.
- **Duplicate names handled** — if several records share the same name, the row
  error lists the candidates with their IDs, and an `[ID]` suffix in the cell
  (`John Smith [42]`) picks one explicitly.
- **Imported changes are staged, not saved**: they land on the form like manual
  edits, so you review them and save the record to apply — or discard to cancel.
  A summary notification reports updated/created counts and any row errors.
- **Paste from Excel**: copy cells in a spreadsheet and paste them straight into
  the list via the toolbar clipboard button — no file needed. The header row is
  auto-detected (overridable); with headers the update-by-ID rules apply, without
  headers cells map to the visible columns in order. A live preview shows how many
  lines will be updated or created before you confirm.

### Bulk edit

- **Row selection checkboxes** on the embedded list — core Odoo has neither
  selection nor multi-edit inside one2many lists.
- **Filter-aware "select all"**: with an active filter, the header checkbox
  selects only the visible rows. The killer workflow: *filter → select all →
  set a value on every matching line at once*.
- The **bulk edit dialog** lists the editable columns and adapts the value
  input to the column type (number, native date/datetime pickers, selection
  dropdown, boolean checkbox, many2one resolved by name, many2many as a tag
  picker whose chosen tags replace the lines' current values). Leaving the
  value empty clears the field on the selected lines.
- Changes are **staged** like manual edits and applied when the record is
  saved. While rows are selected, the footer aggregates show the selection's
  totals.

### Line duplication

- **Select one or more lines** and click the duplicate tool in the toolbar. A
  small confirmation dialog asks for the **number of copies per line**
  (default 1, max 50).
- Copies include many2many values (e.g. tags); computed fields are recomputed.
- Copies are **staged** like manual edits: save the record to apply.

### Hierarchy view

- When the lines have a **many2one field pointing at their own model** (e.g.
  `parent_line_id`), a toolbar toggle displays the list as an **indented tree**
  with expand/collapse carets.
- The hierarchy field is **auto-detected**, or set explicitly with the
  `hierarchy_field` option.
- Plays nicely with filtering: the tree is built from the matching rows, and
  rows whose parent is filtered out are promoted to root level.

### Persistent column widths

- Column widths resized by dragging the header separators are **remembered and
  restored after a refresh** — per user, per model and table (stored in the
  browser, nothing written to the database).
- A **reset button** (visible only when custom widths are stored) restores the
  automatic column layout.

## Safe by design

- **Read-only is always respected** — columns read-only on the model or in the
  view (including record-dependent readonly rules) are never modified by bulk
  edit, import, paste or duplication.
- **Permissions too** — no tool adds lines when the list forbids creation, or
  stages edits when the field is read-only.
- **Everything is staged** — every write feature lands its changes on the form
  unsaved, exactly like manual edits: review and save, or discard. Odoo's access
  rights and business rules apply on save, as always.

## Known limitations

- Grouped embedded lists are not supported (the filter button is hidden there).
- Client-side filtering/export is capped at the first 1000 records of the
  recordset; a warning is shown when the recordset is larger.
- Import does not fill one2many or readonly columns; they are reported as ignored.

## Roadmap

This module is actively developed. Upcoming capabilities — included in your
purchase as free updates for this version:

- Saved filter presets per user
- Native support for the sale order lines' sections & notes widget, and more

## Support

Questions, bug reports or feature requests: **meisanqo@outlook.com**
