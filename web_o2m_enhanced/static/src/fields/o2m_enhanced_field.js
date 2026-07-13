/** @odoo-module **/
import { registry } from "@web/core/registry";
import {
    Component,
    markup,
    onMounted,
    onPatched,
    onWillDestroy,
    onWillStart,
    onWillUnmount,
    status,
    useEffect,
    useRef,
    useState,
} from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { Dialog } from "@web/core/dialog/dialog";
import { parseDate, parseDateTime } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { download } from "@web/core/network/download";
import { useService } from "@web/core/utils/hooks";
import { ensureArray } from "@web/core/utils/arrays";
import { escape } from "@web/core/utils/strings";
import { useDebounced } from "@web/core/utils/timing";
import { ListRenderer } from "@web/views/list/list_renderer";
import { X2ManyField, x2ManyField } from "@web/views/fields/x2many/x2many_field";
import { getFormattedValue } from "@web/views/utils";
// Odoo 17: ListRenderer.components aliases `Dropdown` to its internal
// OptionalFieldsDropdown, so import the plain components for the filter menus.
import { Dropdown } from "@web/core/dropdown/dropdown";

const CLOSE_ANIMATION_MS = 180;
// Safety cap when loading every page for cross-page filtering.
const FULL_LOAD_LIMIT = 1000;

const NUM = "(-?\\d+(?:[.,]\\d+)?)";
const NUMERIC_RANGE_REGEX = new RegExp(`^${NUM}?\\s*-\\s*${NUM}?$`);
const NUMERIC_OPERATOR_REGEX = new RegExp(`^(>=|<=|!=|>|<|=)\\s*${NUM}$`);

/**
 * @returns {"text" | "number" | "select" | "boolean" | "date" | "relsel"}
 */
function getFilterType(field) {
    switch (field?.type) {
        case "integer":
        case "float":
        case "monetary":
            return "number";
        case "selection":
            return "select";
        case "boolean":
            return "boolean";
        case "date":
        case "datetime":
            return "date";
        case "many2one":
        case "many2many":
        case "one2many":
            return "relsel";
        default:
            return "text";
    }
}

function isEmptyFilterValue(type, value) {
    if (value === undefined || value === null) {
        return true;
    }
    if (type === "date") {
        return !(value.from || value.to);
    }
    if (Array.isArray(value)) {
        return !value.length;
    }
    return !String(value).trim();
}

function parseNum(text) {
    const num = parseFloat(String(text).replace(",", "."));
    return isNaN(num) ? null : num;
}

/** True when a number-column needle is a range/operator condition rather than plain text. */
function isNumericCondition(needle) {
    const rangeMatch = needle.match(NUMERIC_RANGE_REGEX);
    if (rangeMatch && (rangeMatch[1] !== undefined || rangeMatch[2] !== undefined)) {
        return true;
    }
    return NUMERIC_OPERATOR_REGEX.test(needle);
}

/** A record's cell value in a spreadsheet-friendly (and re-importable) form. */
function recordCellValue(record, column, field) {
    const raw = record.data[column.name];
    switch (field.type) {
        case "integer":
        case "float":
        case "monetary":
            return typeof raw === "number" ? raw : false;
        case "boolean":
            return Boolean(raw);
        case "date":
            return raw ? raw.toISODate() : false;
        case "datetime":
            return raw ? raw.toFormat("yyyy-MM-dd HH:mm:ss") : false;
        case "many2one":
            // Odoo 18: many2one values in record.data are [id, display_name] pairs.
            return raw ? String(raw[1] || "") : false;
        case "many2many":
        case "one2many":
            return (raw?.records || [])
                .map((sub) => String(sub.data.display_name || sub.data.name || ""))
                .join(", ");
        case "selection": {
            const option = (field.selection || []).find(([value]) => value === raw);
            return option ? option[1] : false;
        }
        default:
            return String(getFormattedValue(record, column.name, column) ?? "");
    }
}

const TRUTHY_CELLS = ["true", "1", "yes"];
const FALSY_CELLS = ["false", "0", "no", ""];

/** Error for a relational cell whose name matches several records. */
function ambiguousNameError(name, field, candidates) {
    const list = candidates.map(([id, label]) => `${label} [${id}]`).join(", ");
    return _t(
        '"%(name)s" matches several records in %(relation)s: %(list)s. Append the ID, e.g. "%(example)s", to pick one.',
        {
            name,
            relation: field.relation,
            list,
            example: `${name} [${candidates[0][0]}]`,
        }
    );
}

/**
 * Convert an imported cell into a value for `record.update()`.
 * @returns {{value: any} | {error: string}}
 */
function cellToFieldValue(cell, field, m2oNameMap) {
    if (cell === null || cell === undefined || cell === "") {
        return { value: false };
    }
    switch (field.type) {
        case "integer":
        case "float":
        case "monetary": {
            const num = typeof cell === "number" ? cell : parseNum(cell);
            if (num === null || isNaN(num)) {
                return { error: _t("invalid number: %s", cell) };
            }
            return { value: field.type === "integer" ? Math.round(num) : num };
        }
        case "boolean": {
            if (typeof cell === "boolean") {
                return { value: cell };
            }
            const text = String(cell).trim().toLowerCase();
            if (TRUTHY_CELLS.includes(text)) {
                return { value: true };
            }
            if (FALSY_CELLS.includes(text)) {
                return { value: false };
            }
            return { error: _t("invalid boolean: %s", cell) };
        }
        case "date":
        case "datetime": {
            const text = String(cell).trim();
            let parsed = luxon.DateTime.fromISO(text.replace(" ", "T"));
            if (!parsed.isValid) {
                // Fall back to the user's locale format (pasted Excel cells).
                try {
                    parsed = field.type === "date" ? parseDate(text) : parseDateTime(text);
                } catch {
                    parsed = null;
                }
            }
            if (!parsed || !parsed.isValid) {
                return { error: _t("invalid date: %s (expected e.g. 2026-12-31)", cell) };
            }
            return { value: parsed };
        }
        case "selection": {
            const text = String(cell).trim().toLowerCase();
            const option = (field.selection || []).find(
                ([value, label]) =>
                    String(value).toLowerCase() === text || String(label).toLowerCase() === text
            );
            if (!option) {
                return { error: _t("invalid choice: %s", cell) };
            }
            return { value: option[0] };
        }
        case "many2one": {
            const name = String(cell).trim();
            const match = m2oNameMap.get(name.toLowerCase());
            if (match === undefined) {
                return { error: _t("'%s' not found in %s", name, field.relation) };
            }
            if (match.ambiguous) {
                return { error: ambiguousNameError(name, field, match.ambiguous) };
            }
            // record.update() expects the Odoo 18 [id, display_name] pair.
            return { value: [match.id, match.display_name] };
        }
        default:
            return { value: String(cell) };
    }
}

/**
 * Convert a many2many cell ("Tag A, Tag B") into resolved tags.
 * @returns {{value: Array} | {error: string}}
 */
function m2mCellToTags(cell, field, nameMap) {
    if (cell === null || cell === undefined || cell === "") {
        return { value: [] };
    }
    const tags = [];
    for (const part of String(cell).split(",")) {
        const name = part.trim();
        if (!name) {
            continue;
        }
        const match = nameMap.get(name.toLowerCase());
        if (match === undefined) {
            return { error: _t("'%s' not found in %s", name, field.relation) };
        }
        if (match.ambiguous) {
            return { error: ambiguousNameError(name, field, match.ambiguous) };
        }
        if (!tags.some((tag) => tag.id === match.id)) {
            tags.push(match);
        }
    }
    return { value: tags };
}

/** True when an imported value equals the record's current one (avoids dirtying). */
function isSameFieldValue(record, name, field, value) {
    const raw = record.data[name];
    switch (field.type) {
        case "many2one":
            return (raw ? raw[0] : false) === (value ? value[0] : false);
        case "date":
        case "datetime": {
            const rawIso = raw ? raw.toISO() : false;
            const valueIso = value ? value.toISO() : false;
            return rawIso === valueIso;
        }
        case "boolean":
            return Boolean(raw) === Boolean(value);
        default:
            return (raw || false) === (value || false);
    }
}

function matchRecord(record, column, field, type, value) {
    const raw = record.data[column.name];
    if (type === "select") {
        // `value` is a list of selected option values (OR semantics).
        return Array.isArray(value) ? value.includes(raw) : raw === value;
    }
    if (type === "boolean") {
        return String(Boolean(raw)) === value;
    }
    if (type === "date") {
        // Bounds are "YYYY-MM-DD"; raw date/datetime values are luxon DateTime
        // instances, so both sides compare as ISO strings.
        const iso = raw && raw.toISODate && raw.toISODate();
        if (!iso) {
            return false;
        }
        return (!value.from || iso >= value.from) && (!value.to || iso <= value.to);
    }
    if (type === "number") {
        const needle = String(value).trim();
        const num = typeof raw === "number" ? raw : parseFloat(raw);
        const rangeMatch = needle.match(NUMERIC_RANGE_REGEX);
        if (rangeMatch && (rangeMatch[1] !== undefined || rangeMatch[2] !== undefined)) {
            if (isNaN(num)) {
                return false;
            }
            const min = rangeMatch[1] !== undefined ? parseNum(rangeMatch[1]) : null;
            const max = rangeMatch[2] !== undefined ? parseNum(rangeMatch[2]) : null;
            return (min === null || num >= min) && (max === null || num <= max);
        }
        const opMatch = needle.match(NUMERIC_OPERATOR_REGEX);
        if (opMatch) {
            if (isNaN(num)) {
                return false;
            }
            const wanted = parseNum(opMatch[2]);
            switch (opMatch[1]) {
                case ">":
                    return num > wanted;
                case "<":
                    return num < wanted;
                case ">=":
                    return num >= wanted;
                case "<=":
                    return num <= wanted;
                case "!=":
                    return num !== wanted;
                default:
                    return num === wanted;
            }
        }
        // Plain text: "contains" on the displayed value, and also on the raw
        // number so e.g. "25000" finds a cell displayed as "25,000.00".
        const formatted = String(getFormattedValue(record, column.name, column) ?? "");
        if (formatted.toLowerCase().includes(needle.toLowerCase())) {
            return true;
        }
        return !isNaN(num) && String(num).includes(needle.replace(",", "."));
    }
    if (type === "relsel") {
        // `value` is a list of selected record ids (OR semantics).
        if (field.type === "many2one") {
            return Boolean(raw) && value.includes(raw[0]);
        }
        const subRecords = raw?.records || [];
        return subRecords.some((sub) => value.includes(sub.resId));
    }
    const needle = String(value).trim().toLowerCase();
    const formatted = String(getFormattedValue(record, column.name, column) ?? "");
    return formatted.toLowerCase().includes(needle);
}

const MAX_LINE_COPIES = 50;

/**
 * Parse clipboard text (Excel copies are TSV; also accepts ; or , separated)
 * into rows of cells, honoring quoted cells with embedded delimiters/newlines.
 */
export function parseClipboardTable(text) {
    const endOfFirstLine = text.indexOf("\n");
    const firstLine = endOfFirstLine === -1 ? text : text.slice(0, endOfFirstLine);
    const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += char;
            }
        } else if (char === '"' && cell === "") {
            inQuotes = true;
        } else if (char === delimiter) {
            row.push(cell);
            cell = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") {
                i++;
            }
            row.push(cell);
            cell = "";
            rows.push(row);
            row = [];
        } else {
            cell += char;
        }
    }
    if (cell !== "" || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((cells) => cells.some((value) => String(value).trim() !== ""));
}

/** Paste-from-Excel dialog: textarea + header detection + preview. */
export class O2mPasteDialog extends Component {
    static template = "web_o2m_enhanced.O2mPasteDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        confirm: Function,
        columns: Array, // [{name, label}] of the list's spreadsheet columns
    };

    setup() {
        this.state = useState({ text: "", headersOverride: null });
        this.title = _t("Paste from Excel");
        this.pasteAreaRef = useRef("pasteArea");
        onWillStart(async () => {
            // Best effort: pre-fill with the clipboard when the browser allows.
            try {
                this.state.text = (await navigator.clipboard.readText()) || "";
            } catch {
                // Permission denied/unsupported: the user pastes manually.
            }
        });
        // (Re)focus the paste zone whenever it is shown, so Ctrl+V just works.
        useEffect(
            (hasRows) => {
                if (!hasRows) {
                    this.pasteAreaRef.el?.focus();
                }
            },
            () => [this.parsedRows.length > 0]
        );
    }

    get parsedRows() {
        return parseClipboardTable(this.state.text);
    }

    /** The preview table's header cells. */
    get previewHeaders() {
        return this.hasHeaders
            ? this.parsedRows[0].map((cell) => String(cell ?? ""))
            : this.props.columns.map((column) => column.label);
    }

    /** The first data rows, padded to the header width for a clean table. */
    get previewRows() {
        const width = this.previewHeaders.length;
        return this.dataRows
            .slice(0, 8)
            .map((row) => Array.from({ length: width }, (_, i) => String(row[i] ?? "")));
    }

    get previewMoreCount() {
        return Math.max(this.dataRows.length - 8, 0);
    }

    onPaste(ev) {
        ev.preventDefault();
        this.state.text = ev.clipboardData?.getData("text/plain") || "";
        this.state.headersOverride = null;
    }

    clearPaste() {
        this.state.text = "";
        this.state.headersOverride = null;
    }

    /** Does the first pasted row look like a header row? */
    get hasHeaders() {
        if (this.state.headersOverride !== null) {
            return this.state.headersOverride;
        }
        const firstRow = this.parsedRows[0];
        if (!firstRow) {
            return false;
        }
        const known = new Set(["id"]);
        for (const column of this.props.columns) {
            known.add(String(column.label).trim().toLowerCase());
            known.add(column.name.toLowerCase());
        }
        return firstRow.some((cell) => known.has(String(cell ?? "").trim().toLowerCase()));
    }

    get headers() {
        return this.hasHeaders
            ? this.parsedRows[0].map((cell) => String(cell ?? ""))
            : this.props.columns.map((column) => column.name);
    }

    get dataRows() {
        return this.hasHeaders ? this.parsedRows.slice(1) : this.parsedRows;
    }

    get previewText() {
        const rows = this.dataRows;
        if (!rows.length) {
            return "";
        }
        if (!this.hasHeaders) {
            return _t(
                "%(rows)s new line(s); no header row, so cells map to the columns in order: %(columns)s.",
                {
                    rows: rows.length,
                    columns: this.props.columns.map((column) => column.label).join(", "),
                }
            );
        }
        const idIndex = this.headers.findIndex(
            (header) => header.trim().toLowerCase() === "id"
        );
        let updates = 0;
        if (idIndex !== -1) {
            updates = rows.filter((row) =>
                parseInt(String(row[idIndex] ?? "").trim(), 10)
            ).length;
        }
        return _t("%(rows)s row(s): %(updates)s update(s) by ID, %(creates)s new line(s).", {
            rows: rows.length,
            updates,
            creates: rows.length - updates,
        });
    }

    onHeadersToggle(ev) {
        this.state.headersOverride = ev.target.checked;
    }

    onConfirm() {
        if (!this.dataRows.length) {
            return;
        }
        this.props.confirm(this.headers, this.dataRows);
        this.props.close();
    }
}

/** Bulk-edit dialog: pick an editable column, type a value, apply to the selection. */
export class O2mBulkEditDialog extends Component {
    static template = "web_o2m_enhanced.O2mBulkEditDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        confirm: Function,
        fields: Array,
        count: Number,
    };

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            fieldName: this.props.fields[0]?.name || "",
            text: "",
            boolChoice: "true",
            tags: [],
            tagSearch: "",
            tagOptions: [],
            m2o: null,
            m2oSearch: "",
            m2oOptions: [],
        });
        this.title = _t("Edit selected lines");
        this.subtitle = _t("Set a value on the %s selected line(s).", this.props.count);
        onWillStart(() =>
            Promise.all([this._loadTagOptions(""), this._loadM2oOptions("")])
        );
    }

    get selectedField() {
        return this.props.fields.find((f) => f.name === this.state.fieldName);
    }

    async _loadTagOptions(name) {
        const field = this.selectedField;
        if (!field || field.type !== "many2many") {
            return;
        }
        const matches = await this.orm.call(field.relation, "name_search", [], {
            name,
            limit: 30,
        });
        this.state.tagOptions = matches.map(([id, display_name]) => ({ id, display_name }));
    }

    onTagInput(ev) {
        const value = ev.target.value;
        const match = this.state.tagOptions.find((o) => o.display_name === value);
        if (match) {
            if (!this.state.tags.some((t) => t.id === match.id)) {
                this.state.tags.push({ ...match });
            }
            this.state.tagSearch = "";
            ev.target.value = "";
            this._loadTagOptions("");
        } else {
            this._loadTagOptions(value);
        }
    }

    removeTag(id) {
        this.state.tags = this.state.tags.filter((t) => t.id !== id);
    }

    async _loadM2oOptions(name) {
        const field = this.selectedField;
        if (!field || field.type !== "many2one") {
            return;
        }
        const matches = await this.orm.call(field.relation, "name_search", [], {
            name,
            limit: 30,
        });
        this.state.m2oOptions = matches.map(([id, display_name]) => ({ id, display_name }));
    }

    onM2oInput(ev) {
        const value = ev.target.value;
        const match = this.state.m2oOptions.find((o) => o.display_name === value);
        this.state.m2o = match ? { ...match } : null;
        if (!match) {
            this._loadM2oOptions(value);
        }
    }

    get inputType() {
        switch (this.selectedField?.type) {
            case "integer":
            case "float":
            case "monetary":
                return "number";
            case "date":
                return "date";
            case "datetime":
                return "datetime-local";
            default:
                return "text";
        }
    }

    onFieldChange(ev) {
        this.state.fieldName = ev.target.value;
        this.state.text = "";
        this.state.boolChoice = "true";
        this.state.tags = [];
        this.state.tagSearch = "";
        this.state.tagOptions = [];
        this.state.m2o = null;
        this.state.m2oSearch = "";
        this.state.m2oOptions = [];
        this._loadTagOptions("");
        this._loadM2oOptions("");
    }

    onConfirm() {
        const field = this.selectedField;
        if (!field) {
            return;
        }
        let value;
        if (field.type === "boolean") {
            value = this.state.boolChoice === "true";
        } else if (field.type === "many2many") {
            value = [...this.state.tags];
        } else if (field.type === "many2one") {
            // A picked record wins; otherwise the typed text is resolved by
            // name (and an empty text clears the field).
            value = this.state.m2o ? { ...this.state.m2o } : this.state.m2oSearch;
        } else {
            value = this.state.text;
        }
        this.props.confirm(field.name, value);
        this.props.close();
    }

    onKeydown(ev) {
        if (ev.key === "Enter" && ev.target.tagName !== "SELECT") {
            ev.preventDefault();
            this.onConfirm();
        }
    }
}

/** Confirmation dialog for line duplication, with a "number of copies" input. */
export class O2mDuplicateDialog extends Component {
    static template = "web_o2m_enhanced.O2mDuplicateDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        confirm: Function,
        count: Number,
    };

    setup() {
        this.state = useState({ count: 1 });
        this.title = _t("Duplicate lines");
        this.subtitle = _t("Create copies of the %s selected line(s).", this.props.count);
        this.maxCopies = MAX_LINE_COPIES;
    }

    onConfirm() {
        const count = Math.min(Math.max(Math.round(this.state.count) || 1, 1), MAX_LINE_COPIES);
        this.props.confirm(count);
        this.props.close();
    }

    onKeydown(ev) {
        if (ev.key === "Enter") {
            ev.preventDefault();
            this.onConfirm();
        }
    }
}

// Filter-match highlighting for widget-rendered cells. Core renders a column
// through a full Field component whenever it has a widget (canUseFormatter
// refuses it), so the <mark> wrapping done in getFormattedValue never reaches
// those cells. The CSS Custom Highlight API paints text ranges without
// touching the DOM Owl owns. The registry unions the ranges of every enhanced
// list on the page under a single highlight name.
const o2mHighlightRanges = new Map();
function refreshO2mHighlights() {
    if (typeof Highlight === "undefined" || !CSS.highlights) {
        return;
    }
    const ranges = [];
    for (const rs of o2mHighlightRanges.values()) {
        ranges.push(...rs);
    }
    if (ranges.length) {
        CSS.highlights.set("o2m-filter-match", new Highlight(...ranges));
    } else {
        CSS.highlights.delete("o2m-filter-match");
    }
}

export class EnhancedListRenderer extends ListRenderer {
    static template = "web_o2m_enhanced.EnhancedListRenderer";
    static rowsTemplate = "web_o2m_enhanced.EnhancedListRenderer.Rows";
    static recordRowTemplate = "web_o2m_enhanced.EnhancedListRenderer.RecordRow";
    static props = [...ListRenderer.props, "o2mFilter?"];
    // The filter menus need the plain Dropdown, but core aliases the `Dropdown`
    // key to its OptionalFieldsDropdown (which takes an extra listRendererClass
    // prop for the optional-columns gear menu). Overriding that key would feed
    // the gear menu a plain Dropdown and make it throw "unknown key
    // 'listRendererClass'", so register ours under a distinct name instead.
    // DropdownItem and CheckBox are already the plain components in core's map.
    static components = { ...ListRenderer.components, FilterDropdown: Dropdown };

    setup() {
        super.setup();
        this.datetimePickerService = useService("datetime_picker");
        this.datePickers = {};
        // Repaint the filter-match highlights of widget-rendered cells after
        // each render; drop this renderer's ranges when it goes away.
        useEffect(() => this._applyFilterHighlights());
        onWillDestroy(() => {
            o2mHighlightRanges.delete(this);
            refreshO2mHighlights();
        });
        this.o2mImportInputRef = useRef("o2mImportInput");
        this.o2mTreeState = useState({ active: false, collapsed: {} });
        this._o2mTreeInfo = null;
        useEffect(
            (active, closing) => {
                if (active && !closing) {
                    this._enableDatePickers();
                    this.tableRef.el?.querySelector(".o_o2m_filter_col_input")?.focus();
                } else if (!active) {
                    for (const picker of Object.values(this.datePickers)) {
                        picker.close?.();
                    }
                }
            },
            () => [this.o2mState?.active, this.o2mState?.closing]
        );
        // Inputs are re-created on each patch of the filter row; re-attach the
        // picker listeners (idempotent) so the service keeps them in sync.
        onPatched(() => {
            if (this.o2mState?.active && !this.o2mState.closing) {
                this._enableDatePickers();
            }
        });
        onWillDestroy(() => {
            for (const picker of Object.values(this.datePickers)) {
                // Odoo 18's picker exposes neither close() nor disable(); its
                // popover closes itself when the anchor leaves the DOM.
                picker.close?.();
                picker.disable?.();
            }
            this._removeResizeCapture?.();
        });

        // --- Persistent column widths ---
        // Odoo 17's ListRenderer drives resizing through its own `onStartResize`
        // method and `this.columnWidths` is a plain array (there is no width
        // hook like in 18/19). The resize interception is therefore done by
        // overriding `onStartResize` below; here we only re-apply the stored
        // widths after each render.
        // Re-apply saved widths after each render: this effect is registered
        // after the core one, so it runs once the core widths are in place.
        useEffect(() => this._applyStoredColumnWidths());
        // The core hook also re-applies its computed widths outside of the
        // rendering cycle when the available width changes (window resize,
        // chatter/sidebar toggle); mirror that with a later-firing observer.
        const debouncedApply = useDebounced(
            () => {
                if (status(this) !== "destroyed") {
                    this._applyStoredColumnWidths();
                }
            },
            250,
            { trailing: true }
        );
        const widthObserver = new ResizeObserver(() => debouncedApply());
        onMounted(() => {
            if (this.tableRef.el) {
                widthObserver.observe(this.tableRef.el.parentNode);
            }
        });
        onWillUnmount(() => widthObserver.disconnect());
    }

    /**
     * Odoo 17 keeps the active columns in `state.columns` (18/19 expose them as
     * `this.columns`); alias it so the shared code and template keep working.
     */
    get columns() {
        return this.state.columns;
    }

    /**
     * Odoo 17 binds the header resize handle to this method directly. Wrap it
     * so the final widths can be saved once the drag ends.
     */
    onStartResize(ev) {
        super.onStartResize(ev);
        this._captureResizeEnd();
    }

    /**
     * Odoo 17's core `toggleRecordSelection` unconditionally calls
     * `this.props.list.selectDomain(false)` at the end (18/19 dropped that line).
     * `selectDomain` only exists on DynamicList; the x2many StaticList used by a
     * one2many has no such method, so enabling row selectors on the o2m (which
     * this module does for bulk edit) makes every checkbox click throw
     * "selectDomain is not a function". Guard it here.
     */
    toggleRecordSelection(record, ev) {
        if (!this.canSelectRecord) {
            return;
        }
        const isRecordPresent = this.props.list.records.includes(this.lastCheckedRecord);
        if (this.shiftKeyMode && isRecordPresent) {
            this.toggleRecordShiftSelection(record);
        } else {
            record.toggleSelection();
        }
        this.lastCheckedRecord = record;
        this.props.list.selectDomain?.(false);
    }

    /**
     * Odoo 17 recomputes the column widths from the *visible* content on every
     * freeze (whenever `keepColumnWidths` is falsy). Filtering changes which
     * rows are visible, so without this the columns jump around as the user
     * picks filter values. Freeze the widths once computed (like 18/19 do), and
     * only re-measure when the column set changes or the window is resized
     * (core clears `keepColumnWidths` there).
     */
    freezeColumnWidths() {
        const colCount = this.state.columns.length;
        if (this._o2mFrozenColCount !== colCount) {
            this._o2mFrozenColCount = colCount;
            this.keepColumnWidths = false;
            this.columnWidths = null;
        }
        super.freezeColumnWidths();
        this.keepColumnWidths = true;
    }

    /** Stable per-column keys for the saved widths (field name when possible). */
    get _o2mColumnKeys() {
        return this.columns.map((c, i) => (c.type === "field" ? c.name : `${c.type}_${i}`));
    }

    /** Save the widths once the resize drag in progress ends. */
    _captureResizeEnd() {
        this._removeResizeCapture?.();
        const capture = (ev) => {
            // Mirror the core handler: a left-button pointerdown is the one
            // that started the resize, not the one that stops it.
            if (ev.type === "pointerdown" && ev.button === 0) {
                return;
            }
            this._removeResizeCapture();
            this._saveColumnWidths();
            this.render();
        };
        const types = ["pointerup", "pointerdown", "keydown"];
        this._removeResizeCapture = () => {
            for (const type of types) {
                window.removeEventListener(type, capture);
            }
            this._removeResizeCapture = null;
        };
        for (const type of types) {
            window.addEventListener(type, capture);
        }
    }

    _saveColumnWidths() {
        const table = this.tableRef.el;
        const bag = this.props.o2mFilter;
        if (!table || !bag) {
            return;
        }
        const headers = [...table.querySelectorAll("thead th")];
        const offset = this.hasSelectors ? 1 : 0;
        const keys = this._o2mColumnKeys;
        const cols = {};
        headers.forEach((th, index) => {
            const columnIndex = index - offset;
            if (columnIndex >= 0 && columnIndex < keys.length) {
                cols[keys[columnIndex]] = Math.floor(th.getBoundingClientRect().width);
            }
        });
        bag.saveWidths({ cols });
    }

    _applyStoredColumnWidths() {
        const bag = this.props.o2mFilter;
        const table = this.tableRef.el;
        if (!bag || !table || this.props.list.isGrouped) {
            return;
        }
        const stored = bag.loadWidths();
        if (!stored?.cols) {
            return;
        }
        const keys = this._o2mColumnKeys;
        if (keys.some((key) => !(key in stored.cols))) {
            return; // the column set changed since the widths were saved
        }
        const headers = [...table.querySelectorAll("thead th")];
        const offset = this.hasSelectors ? 1 : 0;
        let total = 0;
        headers.forEach((th, index) => {
            const columnIndex = index - offset;
            const width =
                columnIndex >= 0 && columnIndex < keys.length
                    ? stored.cols[keys[columnIndex]]
                    : th.getBoundingClientRect().width;
            th.style.width = `${Math.floor(width)}px`;
            total += Math.floor(width);
        });
        table.style.tableLayout = "fixed";
        table.style.width = `${total}px`;
        // Like the core resize handler: keep an overflowing table from
        // stretching the surrounding layout (the container scrolls instead).
        const parent = table.parentElement;
        if (total > parent.clientWidth && !parent.style.width) {
            parent.style.width = `${Math.floor(parent.getBoundingClientRect().width)}px`;
        }
    }

    onO2mResetWidths() {
        this.props.o2mFilter?.clearWidths();
        // Odoo 17: drop the frozen widths and inline styles so the core
        // recomputes the automatic layout from content on the next render.
        this.keepColumnWidths = false;
        this.columnWidths = null;
        const table = this.tableRef.el;
        if (table) {
            table.style.width = "";
            table.style.tableLayout = "";
            for (const th of table.querySelectorAll("thead th")) {
                th.style.width = "";
                th.style.maxWidth = "";
            }
        }
        this.render();
    }

    _enableDatePickers() {
        if (!this.tableRef.el) {
            return;
        }
        for (const column of this.columns) {
            if (column.type !== "field" || this.getColumnFilterType(column) !== "date") {
                continue;
            }
            const name = column.name;
            if (!this.datePickers[name]) {
                // Odoo 18: getInputs is the second argument of create() (it
                // moved into the params in 19), and the returned picker does
                // not expose close()/disable().
                this.datePickers[name] = this.datetimePickerService.create(
                    {
                        pickerProps: {
                            type: "date",
                            range: true,
                            value: this._getDateFilterValue(name),
                        },
                        onChange: (value) => this._applyDateFilterValue(name, value),
                        onApply: (value) => this._applyDateFilterValue(name, value),
                    },
                    () => [
                        this.tableRef.el?.querySelector(
                            `input.o_o2m_filter_date_start[data-col="${name}"]`
                        ) || null,
                        this.tableRef.el?.querySelector(
                            `input.o_o2m_filter_date_end[data-col="${name}"]`
                        ) || null,
                    ]
                );
            }
            this.datePickers[name].enable();
        }
    }

    _getDateFilterValue(name) {
        const { from, to } = this.o2mState?.cols[name] || {};
        return [from ? luxon.DateTime.fromISO(from) : null, to ? luxon.DateTime.fromISO(to) : null];
    }

    _applyDateFilterValue(name, value) {
        const [start, end] = ensureArray(value);
        this.props.o2mFilter?.setFilter(name, {
            from: (start && start.toISODate()) || "",
            to: (end && end.toISODate()) || "",
        });
    }

    /**
     * Core's document click handler leaves edit mode whenever a click lands
     * on the table but not inside a data row — and leaving edit mode makes
     * core abandon a freshly added empty line. With the filter UI open that
     * happens accidentally: a layout shift between mousedown and mouseup
     * (column widths re-applied, cells re-rendered on the field commit) makes
     * the browser fire the click on the rows' common ancestor (tbody/table),
     * and the filter dropdown menus render in a portal outside the table.
     * Keep the edition in those cases; genuinely external clicks still leave
     * edit mode through super.
     */
    onGlobalClick(ev) {
        if (this.o2mState?.active) {
            const target = ev.target;
            if (
                !target.isConnected ||
                (this.tableRef.el && this.tableRef.el.contains(target)) ||
                target.closest?.(".o_o2m_filter_relsel_menu")
            ) {
                return;
            }
        }
        super.onGlobalClick(ev);
    }

    get o2mState() {
        return this.props.o2mFilter?.state;
    }

    get o2mOptions() {
        return this.props.o2mFilter?.options || {};
    }

    /** True when the view's options exclude this column from filtering. */
    isFilterExcluded(column) {
        return (this.o2mOptions.no_filter_columns || []).includes(column.name);
    }

    get hasActiveFilter() {
        return Boolean(this.props.o2mFilter?.hasNeedles());
    }

    /** The records displayed by the Rows template (filtered/tree + client-side paged). */
    get filteredRecords() {
        const bag = this.props.o2mFilter;
        if (!bag) {
            return this.props.list.records;
        }
        const filterActive = bag.state.active;
        // The bag reads the records through the *field* component's reactive
        // proxy, so its record objects are different proxy instances than the
        // ones behind this renderer's props.list. Core compares records by
        // strict identity (e.g. onCellClicked's `this.editedRecord === record`
        // fast path); rendering the bag's instances makes that check fail and
        // a click on a cell of the row in edition re-enters edit mode, which
        // first *leaves* it — abandoning (deleting) a freshly added empty
        // line. Remap the filtered records to this renderer's own instances.
        let all;
        if (filterActive) {
            const own = new Map(this.props.list.records.map((r) => [r.id, r]));
            all = bag.getFilteredRecords().map((r) => own.get(r.id) || r);
        } else {
            all = this.props.list.records;
        }
        if (this.o2mTreeActive) {
            this._o2mTreeInfo = this._o2mComputeTree(all);
            all = this._o2mTreeInfo.visible;
        } else {
            this._o2mTreeInfo = null;
        }
        if (!filterActive) {
            return all;
        }
        const { offset, pageSize } = bag.state;
        const page = pageSize ? all.slice(offset, offset + pageSize) : [...all];
        // Keep the row being edited and unsaved new rows on screen even if
        // client-side paging would put them on another page.
        const edited = this.props.list.editedRecord;
        for (const record of all) {
            if (!page.includes(record) && (record === edited || record.isNew)) {
                page.push(record);
            }
        }
        return page;
    }

    // --- Hierarchy (tree) mode ---

    /** The many2one field (pointing at the same model) that defines the tree. */
    get o2mHierarchyFieldName() {
        if (this.o2mOptions.disable_hierarchy) {
            return "";
        }
        const list = this.props.list;
        const wanted = this.o2mOptions.hierarchy_field;
        if (wanted) {
            const field = list.fields[wanted];
            return field?.type === "many2one" &&
                field.relation === list.resModel &&
                wanted in list.activeFields
                ? wanted
                : "";
        }
        for (const [name, field] of Object.entries(list.fields)) {
            if (
                field.type === "many2one" &&
                field.relation === list.resModel &&
                name in list.activeFields
            ) {
                return name;
            }
        }
        return "";
    }

    get o2mTreeActive() {
        return this.o2mTreeState.active && Boolean(this.o2mHierarchyFieldName);
    }

    async onO2mTreeToggleMode() {
        this.o2mTreeState.active = !this.o2mTreeState.active;
        if (this.o2mTreeState.active) {
            // The whole recordset must be present for parents to be found.
            await this.props.o2mFilter?.loadAllRows();
        }
    }

    /**
     * Order `records` depth-first along the hierarchy field. Rows whose parent
     * is absent (or filtered out) become roots; collapsed nodes hide their
     * descendants; cycles fall back to root level.
     */
    _o2mComputeTree(records) {
        const parentName = this.o2mHierarchyFieldName;
        const byResId = new Map();
        for (const record of records) {
            if (typeof record.resId === "number") {
                byResId.set(record.resId, record);
            }
        }
        const childrenOf = new Map(); // datapoint id -> child records
        const roots = [];
        for (const record of records) {
            const parentRaw = record.data[parentName];
            const parent = parentRaw && byResId.get(parentRaw[0]);
            if (parent && parent !== record) {
                if (!childrenOf.has(parent.id)) {
                    childrenOf.set(parent.id, []);
                }
                childrenOf.get(parent.id).push(record);
            } else {
                roots.push(record);
            }
        }
        const visible = [];
        const depths = new Map();
        const seen = new Set();
        // Descendants of a collapsed node stay hidden but must count as seen,
        // or the cycle-leftover pass below would resurface them as roots.
        const markSeen = (record) => {
            if (seen.has(record.id)) {
                return;
            }
            seen.add(record.id);
            for (const child of childrenOf.get(record.id) || []) {
                markSeen(child);
            }
        };
        const visit = (record, depth) => {
            if (seen.has(record.id)) {
                return;
            }
            seen.add(record.id);
            depths.set(record.id, depth);
            visible.push(record);
            const children = childrenOf.get(record.id) || [];
            if (this.o2mTreeState.collapsed[record.id]) {
                for (const child of children) {
                    markSeen(child);
                }
                return;
            }
            for (const child of children) {
                visit(child, depth + 1);
            }
        };
        for (const record of roots) {
            visit(record, 0);
        }
        for (const record of records) {
            visit(record, 0); // cycle leftovers
        }
        return { visible, depths, parentIds: new Set(childrenOf.keys()) };
    }

    o2mTreeDepth(record) {
        return this._o2mTreeInfo?.depths.get(record.id) || 0;
    }

    o2mTreeHasChildren(record) {
        return Boolean(this._o2mTreeInfo?.parentIds.has(record.id));
    }

    o2mTreeIsCollapsed(record) {
        return Boolean(this.o2mTreeState.collapsed[record.id]);
    }

    o2mTreeToggle(record) {
        this.o2mTreeState.collapsed[record.id] = !this.o2mTreeState.collapsed[record.id];
    }

    /**
     * The whole prefix (indent + caret) is a large toggle target on parent
     * rows; on leaf rows the click falls through to the cell (edit as usual).
     */
    onO2mTreePrefixClick(record, ev) {
        if (this.o2mTreeHasChildren(record)) {
            ev.stopPropagation();
            this.o2mTreeToggle(record);
        }
    }

    get o2mCounterText() {
        const shown = this.props.o2mFilter.getFilteredRecords().length;
        return `${shown} / ${this.props.list.records.length}`;
    }

    get o2mTruncatedTitle() {
        return _t(
            "Too many records: only the first %s are loaded and filtered.",
            FULL_LOAD_LIMIT
        );
    }

    /**
     * Recompute the footer aggregates on the selected rows (StaticList has no
     * `selection`, so the core selection-totals behaviour never triggers in
     * x2many lists) or, while filtering, on the filtered rows.
     */
    get aggregates() {
        const bag = this.props.o2mFilter;
        if (!bag || this.props.list.isGrouped) {
            return super.aggregates;
        }
        const selected = this.o2mSelectedRecords;
        const filterActive = bag.state.active && bag.hasNeedles();
        if (!selected.length && !filterActive) {
            return super.aggregates;
        }
        const records = filterActive ? bag.getFilteredRecords() : this.props.list.records;
        const realProps = this.props;
        this.props = {
            ...realProps,
            list: new Proxy(realProps.list, {
                get: (target, prop) => {
                    if (prop === "records") {
                        return records;
                    }
                    if (prop === "selection") {
                        return selected;
                    }
                    return Reflect.get(target, prop);
                },
            }),
        };
        try {
            return super.aggregates;
        } finally {
            this.props = realProps;
        }
    }

    /** Wrap the matching part of text/number cells in a <mark> while filtering. */
    getFormattedValue(column, record) {
        const value = super.getFormattedValue(column, record);
        const state = this.o2mState;
        if (!state?.active || state.closing || typeof value !== "string" || !value) {
            return value;
        }
        const ftype = this.getColumnFilterType(column);
        if (ftype !== "text" && ftype !== "number") {
            return value;
        }
        const needle = String(state.cols[column.name] ?? "").trim();
        if (!needle) {
            return value;
        }
        // Range/operator needles (e.g. ">5", "0 - 10") match a condition, not
        // a substring: there is nothing to underline.
        if (ftype === "number" && isNumericCondition(needle)) {
            return value;
        }
        const lower = value.toLowerCase();
        const needleLower = needle.toLowerCase();
        if (!lower.includes(needleLower)) {
            if (ftype === "number") {
                // The needle may have matched the raw number while the cell
                // shows a formatted variant ("25000" vs "25,000.00"): then
                // mark the whole value.
                const raw = record.data[column.name];
                const num = typeof raw === "number" ? raw : parseFloat(raw);
                if (!isNaN(num) && String(num).includes(needle.replace(",", "."))) {
                    return markup(
                        `<mark class="o_o2m_filter_match">${escape(value)}</mark>`
                    );
                }
            }
            return value;
        }
        let html = "";
        let index = 0;
        while (index <= value.length) {
            const at = lower.indexOf(needleLower, index);
            if (at === -1) {
                html += escape(value.slice(index));
                break;
            }
            html += `${escape(value.slice(index, at))}<mark class="o_o2m_filter_match">${escape(
                value.slice(at, at + needle.length)
            )}</mark>`;
            index = at + needle.length;
        }
        return markup(html);
    }

    /**
     * Paint the filter needle inside cells rendered by Field components
     * (columns with a widget): getFormattedValue never runs for those, so the
     * <mark> path cannot reach them. Text ranges are registered in the CSS
     * Custom Highlight API — no DOM mutation, Owl's rendering stays intact.
     * Cells already containing a <mark> (formatter path) and the row in
     * edition (inputs) are skipped.
     */
    _applyFilterHighlights() {
        if (typeof Highlight === "undefined" || !CSS.highlights) {
            return;
        }
        const ranges = [];
        const state = this.o2mState;
        const table = this.tableRef.el;
        if (table && state?.active && !state.closing) {
            for (const [name, rawNeedle] of Object.entries(state.cols)) {
                const field = this.props.list.fields[name];
                const ftype = field && getFilterType(field);
                if (ftype !== "text" && ftype !== "number") {
                    continue;
                }
                const needle = String(rawNeedle ?? "").trim().toLowerCase();
                if (!needle || (ftype === "number" && isNumericCondition(needle))) {
                    continue;
                }
                const cells = table.querySelectorAll(
                    `tbody tr.o_data_row:not(.o_selected_row) td.o_data_cell[name="${name}"]`
                );
                for (const cell of cells) {
                    if (cell.querySelector("mark.o_o2m_filter_match")) {
                        continue;
                    }
                    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
                    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                        const text = node.nodeValue.toLowerCase();
                        let at = text.indexOf(needle);
                        while (at !== -1) {
                            const range = new Range();
                            range.setStart(node, at);
                            range.setEnd(node, at + needle.length);
                            ranges.push(range);
                            at = text.indexOf(needle, at + needle.length);
                        }
                    }
                }
            }
        }
        o2mHighlightRanges.set(this, ranges);
        refreshO2mHighlights();
    }

    getColumnFilterType(column) {
        return getFilterType(this.props.list.fields[column.name]);
    }

    getFilterOptions(column) {
        if (this.getColumnFilterType(column) === "boolean") {
            return [
                ["true", _t("Yes")],
                ["false", _t("No")],
            ];
        }
        return this.props.list.fields[column.name].selection || [];
    }

    hasDateFilter(column) {
        const { from, to } = this.o2mState.cols[column.name] || {};
        return Boolean(from || to);
    }

    /**
     * Distinct related records present in the (fully loaded) rows, as
     * {id, label} items, for many2one / x2many columns.
     */
    getRelFilterOptions(column) {
        const field = this.props.list.fields[column.name];
        const options = new Map();
        for (const record of this.props.list.records) {
            const raw = record.data[column.name];
            if (field.type === "many2one") {
                if (raw) {
                    options.set(raw[0], String(raw[1] || ""));
                }
            } else {
                for (const sub of raw?.records || []) {
                    options.set(sub.resId, String(sub.data.display_name || sub.data.name || ""));
                }
            }
        }
        return [...options.entries()]
            .map(([id, label]) => ({ id, label }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    getRelFilterLabel(column) {
        const selected = this.o2mState.cols[column.name] || [];
        if (!selected.length) {
            return column.label;
        }
        const byId = new Map(this.getRelFilterOptions(column).map((o) => [o.id, o.label]));
        const labels = selected.map((id) => byId.get(id)).filter(Boolean);
        if (labels.length > 2) {
            return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
        }
        return labels.join(", ");
    }

    isRelSelected(columnName, id) {
        const current = this.o2mState.cols[columnName];
        return Array.isArray(current) && current.includes(id);
    }

    toggleRelFilter(columnName, id) {
        const state = this.o2mState.cols[columnName];
        const current = Array.isArray(state) ? [...state] : [];
        const index = current.indexOf(id);
        if (index === -1) {
            current.push(id);
        } else {
            current.splice(index, 1);
        }
        this.props.o2mFilter?.setFilter(columnName, current);
    }

    /** Label of a selection column's multi-select filter button. */
    getSelFilterLabel(column) {
        const selected = this.o2mState.cols[column.name];
        if (!Array.isArray(selected) || !selected.length) {
            return column.label;
        }
        const byValue = new Map(this.getFilterOptions(column).map(([value, label]) => [value, label]));
        const labels = selected.map((value) => byValue.get(value)).filter(Boolean);
        if (labels.length > 2) {
            return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
        }
        return labels.join(", ");
    }

    onToggleFilter() {
        this.props.o2mFilter?.toggle();
    }

    onColFilterInput(columnName, ev) {
        this.props.o2mFilter?.setFilter(columnName, ev.target.value);
    }

    onDateFilterClear(column) {
        const picker = this.datePickers[column.name];
        if (picker) {
            picker.close?.();
            picker.state.value = [null, null];
        }
        this.props.o2mFilter?.setFilter(column.name, { from: "", to: "" });
    }

    onClearAllFilters() {
        for (const picker of Object.values(this.datePickers)) {
            picker.close?.();
            picker.state.value = [null, null];
        }
        this.props.o2mFilter?.clearAll();
    }

    get o2mCanDuplicate() {
        return this.activeActions?.create !== false;
    }

    onO2mDuplicateSelected() {
        this.props.o2mFilter?.duplicateSelected();
    }

    onO2mBulkEdit() {
        this.props.o2mFilter?.bulkEdit();
    }

    /**
     * The selected rows. StaticList (x2many) hardcodes `get selection()` to an
     * empty array, so the records' own `selected` flag is the only source of
     * truth here.
     */
    get o2mSelectedRecords() {
        return this.props.list.records.filter((record) => record.selected);
    }

    /** The rows the header "select all" checkbox operates on. */
    get _o2mSelectionScope() {
        const bag = this.props.o2mFilter;
        return bag?.hasNeedles() ? bag.getFilteredRecords() : this.props.list.records;
    }

    get selectAll() {
        const bag = this.props.o2mFilter;
        if (!bag) {
            return super.selectAll;
        }
        // StaticList has no isDomainSelected; with an active filter, "all"
        // means all *displayed* rows.
        const records = this._o2mSelectionScope;
        return records.length > 0 && records.every((record) => record.selected);
    }

    toggleSelection() {
        const list = this.props.list;
        if (!this.props.o2mFilter) {
            return super.toggleSelection();
        }
        if (!this.canSelectRecord) {
            return;
        }
        // StaticList (x2many) has no list-level toggleSelection: toggle the
        // displayed rows one by one instead.
        const records = this._o2mSelectionScope;
        const selectAll = !(records.length && records.every((record) => record.selected));
        for (const record of records) {
            if (record.selected !== selectAll) {
                record.toggleSelection(selectAll);
            }
        }
    }

    onO2mExport() {
        this.props.o2mFilter?.exportXlsx();
    }

    onO2mImportClick() {
        this.o2mImportInputRef.el?.click();
    }

    onO2mPaste() {
        this.props.o2mFilter?.pasteTable();
    }

    async onO2mImportFile(ev) {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = "";
        if (file) {
            await this.props.o2mFilter?.importFile(file);
        }
    }

    onFilterKeydown(ev) {
        if (ev.key === "Escape") {
            ev.stopPropagation();
            this.onToggleFilter();
        }
    }
}

export class EnhancedOne2ManyField extends X2ManyField {
    static template = "web_o2m_enhanced.EnhancedOne2ManyField";
    static components = {
        ...X2ManyField.components,
        ListRenderer: EnhancedListRenderer,
    };

    setup() {
        super.setup();
        this.o2mNotification = useService("notification");
        this.o2mOrm = useService("orm");
        this.o2mDialog = useService("dialog");
        // Odoo 17 has no standalone `rpc`/`user` exports (added in 18); use the
        // services instead.
        this.rpc = useService("rpc");
        this.user = useService("user");
        this.o2mFilterState = useState({
            active: false,
            closing: false,
            cols: {},
            offset: 0,
            pageSize: 0,
            truncated: false,
        });
        this._closeTimer = null;
        this._origPaging = null;
        onWillDestroy(() => browser.clearTimeout(this._closeTimer));
        onMounted(() => {
            if (
                this.o2mOptions.default_open &&
                !this.o2mOptions.disable_filter &&
                !this.o2mFilterState.active
            ) {
                this.toggleO2mFilter();
            }
        });
    }

    /** Per-view widget options, from the field tag's options="{...}" dict. */
    get o2mOptions() {
        return this.props.crudOptions || {};
    }

    /** Odoo 18's X2ManyField has no canCreate getter (added in 19). */
    get canCreate() {
        return (
            ("link" in this.activeActions ? this.activeActions.link : this.activeActions.create) &&
            !this.props.readonly
        );
    }

    /** True when the widget must not stage changes on existing lines. */
    get o2mReadonly() {
        // Odoo 18 only sets activeActions.write for many2many fields; on a
        // one2many it stays undefined (Odoo 19 sets it to
        // `(isMany2Many || !readonly) && evalAction("write")`). Treat write as
        // allowed unless it is *explicitly* denied (=== false), so bulk edit /
        // import / paste work on one2many lists as they do in 19.
        return this.props.readonly || this.activeActions.write === false;
    }

    /**
     * True when `fieldName` must not be edited on `record`: readonly on the
     * model, or readonly in the view (static attribute or record-dependent
     * expression, like the cells rendered by the list itself).
     */
    o2mCellReadonly(record, fieldName) {
        if (this.list.fields[fieldName]?.readonly) {
            return true;
        }
        try {
            return record._isReadonly(fieldName);
        } catch {
            return false;
        }
    }

    get o2mFilterColumns() {
        return (this.archInfo.columns || []).filter((c) => c.type === "field");
    }

    /** Columns worth putting in a spreadsheet (everything but the drag handle). */
    get o2mSpreadsheetColumns() {
        return this.o2mFilterColumns.filter((c) => c.widget !== "handle");
    }

    get o2mNeedleEntries() {
        return Object.entries(this.o2mFilterState.cols).filter(([name, value]) => {
            const type = getFilterType(this.list.fields[name]);
            return !isEmptyFilterValue(type, value);
        });
    }

    get o2mFilteredRecords() {
        const records = this.list.records;
        const entries = this.o2mNeedleEntries;
        if (!entries.length) {
            return records;
        }
        const filters = entries
            .map(([name, value]) => {
                const column = this.o2mFilterColumns.find((c) => c.name === name);
                const field = this.list.fields[name];
                return column && field ? [column, field, getFilterType(field), value] : null;
            })
            .filter(Boolean);
        // The row currently being edited and unsaved new rows always stay
        // visible, even when they don't match the filters — otherwise they
        // would vanish mid-edit. New rows must be covered on their own (not
        // only via editedRecord): while the focus moves between two cells the
        // record briefly leaves edition, and if that render dropped the row
        // the click would land on nothing and core would abandon the line.
        const editedRecord = this.list.editedRecord;
        return records.filter(
            (record) =>
                record === editedRecord ||
                record.isNew ||
                filters.every(([column, field, type, value]) =>
                    matchRecord(record, column, field, type, value)
                )
        );
    }

    /** Keep the pager visible (and working) while the filter bar is open. */
    get showO2mFilterPager() {
        const pageSize = this.o2mFilterState.pageSize || this.list.limit;
        return this.o2mFilterState.active && this.list.count > pageSize;
    }

    get pagerProps() {
        const base = super.pagerProps;
        const state = this.o2mFilterState;
        if (!state.active) {
            return base;
        }
        const pageSize = state.pageSize || base.limit;
        const total = this.o2mFilteredRecords.length;
        return {
            offset: Math.min(state.offset, Math.max(total - 1, 0)),
            limit: pageSize,
            total,
            onUpdate: ({ offset, limit }) => {
                state.offset = offset;
                state.pageSize = limit;
            },
            withAccessKey: false,
        };
    }

    get rendererProps() {
        const props = super.rendererProps;
        // Row selection checkboxes, for bulk edit (core x2many disables them).
        props.allowSelectors = !this.props.readonly && !this.o2mOptions.disable_selection;
        props.o2mFilter = {
            options: this.o2mOptions,
            state: this.o2mFilterState,
            toggle: () => this.toggleO2mFilter(),
            setFilter: (name, value) => {
                this.o2mFilterState.cols[name] = value;
                this.o2mFilterState.offset = 0;
            },
            hasNeedles: () => this.o2mNeedleEntries.length > 0,
            getFilteredRecords: () => this.o2mFilteredRecords,
            clearAll: () => {
                this.o2mFilterState.cols = {};
                this.o2mFilterState.offset = 0;
            },
            exportXlsx: () => this.o2mExportXlsx(),
            importFile: (file) => this.o2mImportFile(file),
            pasteTable: () => this.o2mOpenPasteDialog(),
            duplicateSelected: () => this.o2mAskDuplicateSelected(),
            bulkEdit: () => this.o2mBulkEdit(),
            loadAllRows: () => this._o2mLoadAllRows(),
            loadWidths: () => this.o2mLoadColumnWidths(),
            saveWidths: (widths) => this.o2mSaveColumnWidths(widths),
            clearWidths: () => this.o2mClearColumnWidths(),
            hasStoredWidths: () => Boolean(this.o2mLoadColumnWidths()),
        };
        return props;
    }

    /** Column widths are stored per user, parent model and o2m field. */
    get _o2mWidthsStorageKey() {
        return `web_o2m_enhanced.colwidths.${this.user.userId}.${this.props.record.resModel}.${this.props.name}`;
    }

    o2mLoadColumnWidths() {
        if (this.o2mOptions.save_column_widths === false) {
            return null;
        }
        try {
            const raw = browser.localStorage.getItem(this._o2mWidthsStorageKey);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    o2mSaveColumnWidths(widths) {
        if (this.o2mOptions.save_column_widths === false) {
            return;
        }
        try {
            browser.localStorage.setItem(this._o2mWidthsStorageKey, JSON.stringify(widths));
        } catch {
            // Storage full/unavailable: widths just won't persist.
        }
    }

    o2mClearColumnWidths() {
        browser.localStorage.removeItem(this._o2mWidthsStorageKey);
    }

    o2mBulkEdit() {
        const list = this.list;
        if (this.o2mReadonly) {
            return;
        }
        // StaticList.selection is hardcoded empty: read the records' flag.
        const count = list.records.filter((record) => record.selected).length;
        if (!count) {
            return;
        }
        const fields = this.o2mSpreadsheetColumns
            .map((column) => ({ column, field: list.fields[column.name] }))
            .filter(({ field }) => field && !field.readonly && field.type !== "one2many")
            .map(({ column, field }) => ({
                name: column.name,
                label: String(column.label),
                type: field.type,
                selection: field.selection || [],
                relation: field.relation || "",
            }));
        if (!fields.length) {
            this.o2mNotification.add(_t("No editable columns in this list."), {
                type: "warning",
            });
            return;
        }
        this.o2mDialog.add(O2mBulkEditDialog, {
            fields,
            count,
            confirm: (fieldName, rawValue) => this._o2mApplyBulkEdit(fieldName, rawValue),
        });
    }

    async _o2mApplyBulkEdit(fieldName, rawValue) {
        try {
            const list = this.list;
            const field = list.fields[fieldName];
            if (this.o2mReadonly) {
                return;
            }
            const selected = list.records.filter((record) => record.selected);
            if (!selected.length) {
                return;
            }
            // Rows where the view makes this column read-only are not touched
            // (same rule as editing the cell by hand).
            const records = selected.filter(
                (record) => !this.o2mCellReadonly(record, fieldName)
            );
            const skipped = selected.length - records.length;
            const doneMessage = (changed) => {
                const parts = [
                    _t(
                        "%(changed)s of %(count)s selected line(s) updated. The changes are staged on the form: review them and save the record.",
                        { changed, count: selected.length }
                    ),
                ];
                if (skipped) {
                    parts.push(
                        _t("%s line(s) skipped: the field is read-only there.", skipped)
                    );
                }
                return parts.join("\n");
            };
            if (!records.length) {
                this.o2mNotification.add(doneMessage(0), { type: "warning" });
                return;
            }
            // Many2many: the chosen tags replace each line's current values.
            if (field.type === "many2many") {
                const tags = Array.isArray(rawValue) ? rawValue : [];
                let changed = 0;
                for (const record of records) {
                    if (await this._o2mReplaceM2m(record, fieldName, tags)) {
                        changed++;
                    }
                }
                this.o2mNotification.add(doneMessage(changed), { type: "success" });
                return;
            }
            // Resolve the many2one name once, like the spreadsheet import does.
            // A record picked in the dialog is used as-is, without a lookup.
            let m2oMap = new Map();
            if (field.type === "many2one" && rawValue && typeof rawValue === "object") {
                const label = String(rawValue.display_name ?? "");
                m2oMap.set(label.trim().toLowerCase(), {
                    id: rawValue.id,
                    display_name: rawValue.display_name,
                });
                rawValue = label;
            } else if (field.type === "many2one" && String(rawValue ?? "").trim()) {
                m2oMap = await this._o2mResolveRelNames(field.relation, [String(rawValue).trim()]);
            }
            const result = cellToFieldValue(rawValue, field, m2oMap);
            if (result.error) {
                this.o2mNotification.add(String(result.error), {
                    title: _t("Bulk edit failed"),
                    type: "danger",
                    sticky: true,
                });
                return;
            }
            let changed = 0;
            for (const record of records) {
                if (!isSameFieldValue(record, fieldName, field, result.value)) {
                    await record.update({ [fieldName]: result.value });
                    changed++;
                }
            }
            this.o2mNotification.add(doneMessage(changed), { type: "success" });
        } catch (error) {
            this.o2mNotification.add(String(error.data?.message || error.message || error), {
                title: _t("Bulk edit failed"),
                type: "danger",
                sticky: true,
            });
        }
    }

    /**
     * Resolve display names to records of `relation`, once per distinct name.
     * An "[id]" suffix ("Acme [42]") picks a record explicitly — the way out
     * when several records share the same name.
     * Values: {id, display_name} or {ambiguous: [[id, name], ...]}; a missing
     * key means "not found".
     */
    async _o2mResolveRelNames(relation, names) {
        const nameMap = new Map();
        for (const rawName of names) {
            const name = String(rawName).trim();
            const key = name.toLowerCase();
            if (!name || nameMap.has(key)) {
                continue;
            }
            const idMatch = name.match(/\[(\d+)\]$/);
            if (idMatch) {
                const resId = parseInt(idMatch[1], 10);
                const found = await this.o2mOrm.searchRead(
                    relation,
                    [["id", "=", resId]],
                    ["display_name"],
                    { limit: 1 }
                );
                if (found.length) {
                    nameMap.set(key, { id: resId, display_name: found[0].display_name });
                }
                continue;
            }
            let matches = await this.o2mOrm.call(relation, "name_search", [], {
                name,
                operator: "=",
                limit: 6,
            });
            if (!matches.length) {
                matches = await this.o2mOrm.call(relation, "name_search", [], {
                    name,
                    operator: "ilike",
                    limit: 6,
                });
            }
            if (matches.length === 1) {
                nameMap.set(key, { id: matches[0][0], display_name: matches[0][1] });
            } else if (matches.length > 1) {
                nameMap.set(key, { ambiguous: matches.slice(0, 5) });
            }
        }
        return nameMap;
    }

    /** True when a record's many2many links already equal `tags`. */
    _o2mM2mSame(record, fieldName, tags) {
        const currentIds = (record.data[fieldName]?.records || [])
            .map((sub) => sub.resId)
            .filter((id) => typeof id === "number");
        const wantedIds = tags.map((tag) => tag.id);
        return (
            currentIds.length === wantedIds.length &&
            currentIds.every((id) => wantedIds.includes(id))
        );
    }

    /** Replace a record's many2many links with `tags`; true when it changed. */
    async _o2mReplaceM2m(record, fieldName, tags) {
        if (this._o2mM2mSame(record, fieldName, tags)) {
            return false;
        }
        const subList = record.data[fieldName];
        const currentIds = (subList?.records || [])
            .map((sub) => sub.resId)
            .filter((id) => typeof id === "number");
        const wantedIds = tags.map((tag) => tag.id);
        for (const id of currentIds) {
            if (!wantedIds.includes(id)) {
                await subList.unlinkFrom(id);
            }
        }
        for (const tag of tags) {
            if (!currentIds.includes(tag.id)) {
                await subList.linkTo(tag.id);
            }
        }
        return true;
    }

    /** Confirm (and ask how many copies) before duplicating the selected lines. */
    o2mAskDuplicateSelected() {
        if (!this.canCreate) {
            return;
        }
        const records = this.list.records.filter((record) => record.selected);
        if (!records.length) {
            return;
        }
        this.o2mDialog.add(O2mDuplicateDialog, {
            count: records.length,
            confirm: (copies) => this._o2mDuplicateLines(records, copies),
        });
    }

    /** Copyable values of one source line (m2m ids applied separately via linkTo). */
    _o2mCopyableValues(record) {
        const fields = this.list.fields;
        const values = {};
        const m2mIds = {};
        for (const [name, field] of Object.entries(fields)) {
            if (name === "id" || field.readonly || !(name in record.data)) {
                continue;
            }
            const raw = record.data[name];
            if (field.type === "many2one") {
                values[name] = raw ? [raw[0], raw[1]] : false;
            } else if (field.type === "many2many") {
                const ids = (raw?.records || [])
                    .map((sub) => sub.resId)
                    .filter((id) => typeof id === "number");
                if (ids.length) {
                    m2mIds[name] = ids;
                }
            } else if (field.type === "one2many") {
                // Linking existing one2many children would re-parent them away
                // from the original line; skip them.
                continue;
            } else {
                values[name] = raw;
            }
        }
        return { values, m2mIds };
    }

    async _o2mDuplicateLines(records, copies) {
        const list = this.list;
        try {
            let created = 0;
            for (const source of records) {
                const { values, m2mIds } = this._o2mCopyableValues(source);
                for (let i = 0; i < copies; i++) {
                    const newRecord = await list.addNewRecord({
                        position: "bottom",
                        mode: "readonly",
                    });
                    // Fields the view makes read-only on the new line keep
                    // their default (usually recomputed) value.
                    const allowed = {};
                    for (const [name, value] of Object.entries(values)) {
                        if (!this.o2mCellReadonly(newRecord, name)) {
                            allowed[name] = value;
                        }
                    }
                    await newRecord.update(allowed);
                    for (const [name, ids] of Object.entries(m2mIds)) {
                        if (this.o2mCellReadonly(newRecord, name)) {
                            continue;
                        }
                        for (const id of ids) {
                            await newRecord.data[name].linkTo(id);
                        }
                    }
                    created++;
                }
            }
            await list.leaveEditMode();
            this.o2mNotification.add(
                _t(
                    "%s new line(s) created. The changes are staged on the form: review them and save the record.",
                    created
                ),
                { type: "success" }
            );
        } catch (error) {
            this.o2mNotification.add(String(error.data?.message || error.message || error), {
                title: _t("Duplication failed"),
                type: "danger",
                sticky: true,
            });
        }
    }

    /** Load every page of the list (up to the cap) so the whole recordset is present. */
    async _o2mLoadAllRows() {
        const list = this.list;
        if (list.count > list.records.length) {
            this._origPaging = this._origPaging || { limit: list.limit, offset: list.offset };
            await list.load({ limit: Math.min(list.count, FULL_LOAD_LIMIT), offset: 0 });
        }
    }

    async o2mExportXlsx() {
        const list = this.list;
        const wasFullyLoaded = list.count <= list.records.length;
        const filterActive = this.o2mFilterState.active;
        await this._o2mLoadAllRows();
        try {
            const records =
                filterActive && this.o2mNeedleEntries.length
                    ? this.o2mFilteredRecords
                    : list.records;
            const columns = this.o2mSpreadsheetColumns;
            const fields = list.fields;
            const headers = [_t("ID"), ...columns.map((c) => c.label)];
            const types = ["id", ...columns.map((c) => fields[c.name].type)];
            const rows = records.map((record) => [
                typeof record.resId === "number" ? record.resId : false,
                ...columns.map((c) => recordCellValue(record, c, fields[c.name])),
            ]);
            await download({
                url: "/web_o2m_enhanced/export_xlsx",
                data: {
                    data: JSON.stringify({
                        filename: `${this.props.record.resModel}_${this.props.name}_${luxon.DateTime.now().toFormat("yyyy-MM-dd_HHmmss")}`,
                        headers,
                        types,
                        rows,
                    }),
                },
            });
            if (list.count > list.records.length) {
                this.o2mNotification.add(
                    _t("Only the first %s records were exported.", FULL_LOAD_LIMIT),
                    { type: "warning" }
                );
            }
        } finally {
            // Restore the original page when the export triggered the full
            // load itself (with the filter bar open, closing it restores).
            if (!wasFullyLoaded && !filterActive && this._origPaging) {
                const { limit, offset } = this._origPaging;
                this._origPaging = null;
                await list.load({ limit, offset });
            }
        }
    }

    async o2mImportFile(file) {
        try {
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            const { headers, rows } = await this.rpc("/web_o2m_enhanced/parse_spreadsheet", {
                filename: file.name,
                content,
            });
            if (!rows.length) {
                this.o2mNotification.add(_t("No data rows found in %s.", file.name), {
                    type: "warning",
                });
                return;
            }
            await this._o2mApplyImport(headers, rows);
        } catch (error) {
            this.o2mNotification.add(String(error.data?.message || error.message || error), {
                title: _t("Import failed"),
                type: "danger",
                sticky: true,
            });
        }
    }

    o2mOpenPasteDialog() {
        this.o2mDialog.add(O2mPasteDialog, {
            columns: this.o2mSpreadsheetColumns.map((column) => ({
                name: column.name,
                label: String(column.label),
            })),
            confirm: (headers, rows) => this._o2mPasteApply(headers, rows),
        });
    }

    async _o2mPasteApply(headers, rows) {
        try {
            await this._o2mApplyImport(headers, rows);
        } catch (error) {
            this.o2mNotification.add(String(error.data?.message || error.message || error), {
                title: _t("Import failed"),
                type: "danger",
                sticky: true,
            });
        }
    }

    async _o2mApplyImport(headers, rows) {
        const list = this.list;
        const fields = list.fields;
        if (this.o2mReadonly && !this.canCreate) {
            return;
        }
        // Updates must be able to find their target row on any page. The list
        // is intentionally left fully loaded afterwards: reloading a shorter
        // page could discard the staged changes.
        await this._o2mLoadAllRows();

        // Map spreadsheet headers onto list columns (by label or field name).
        const skipped = [];
        let idIndex = -1;
        const columnByHeader = headers.map((header, index) => {
            const text = String(header || "").trim();
            if (!text) {
                return null;
            }
            if (text.toLowerCase() === "id") {
                idIndex = index;
                return null;
            }
            const column = this.o2mSpreadsheetColumns.find(
                (c) =>
                    String(c.label).toLowerCase() === text.toLowerCase() ||
                    c.name.toLowerCase() === text.toLowerCase()
            );
            const field = column && fields[column.name];
            if (!field || field.readonly || field.type === "one2many") {
                skipped.push(text);
                return null;
            }
            return column;
        });
        if (!columnByHeader.some(Boolean)) {
            this.o2mNotification.add(
                _t("No column headers match the list. Use an exported file as template."),
                { title: _t("Import failed"), type: "danger", sticky: true }
            );
            return;
        }

        // Resolve many2one/many2many display names -> ids, once per distinct name.
        const m2oMaps = new Map();
        for (let c = 0; c < columnByHeader.length; c++) {
            const column = columnByHeader[c];
            const field = column && fields[column.name];
            if (
                !field ||
                !["many2one", "many2many"].includes(field.type) ||
                m2oMaps.has(column.name)
            ) {
                continue;
            }
            const names = new Set();
            for (const row of rows) {
                const cell = row[c];
                if (cell === null || cell === undefined || cell === "") {
                    continue;
                }
                if (field.type === "many2many") {
                    // m2m cells hold comma-separated display names.
                    for (const part of String(cell).split(",")) {
                        const name = part.trim();
                        if (name) {
                            names.add(name);
                        }
                    }
                } else {
                    names.add(String(cell).trim());
                }
            }
            m2oMaps.set(column.name, await this._o2mResolveRelNames(field.relation, names));
        }

        // Apply row by row: with ID -> update that line, without -> new line.
        const errors = [];
        let updated = 0;
        let created = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNo = i + 2; // 1-based, after the header row
            const idCell = idIndex >= 0 ? row[idIndex] : null;
            const resId =
                typeof idCell === "number"
                    ? idCell
                    : parseInt(String(idCell ?? "").trim(), 10) || null;
            const target = resId ? list.records.find((r) => r.resId === resId) : null;
            if (resId && !target) {
                errors.push(_t("Row %(row)s: no line with ID %(id)s.", { row: rowNo, id: resId }));
                continue;
            }
            if (target && this.o2mReadonly) {
                errors.push(
                    _t("Row %s: the list is read-only, existing lines cannot be updated.", rowNo)
                );
                continue;
            }
            if (!target && !this.canCreate) {
                errors.push(_t("Row %s: adding new lines is not allowed here.", rowNo));
                continue;
            }
            const values = {};
            const m2mValues = {}; // fieldName -> resolved tags, replacing the line's set
            let rowError = false;
            for (let c = 0; c < columnByHeader.length; c++) {
                const column = columnByHeader[c];
                if (!column) {
                    continue;
                }
                const cell = row[c];
                const isEmpty = cell === null || cell === undefined || cell === "";
                if (!target && isEmpty) {
                    continue; // new lines: only fill provided cells
                }
                const field = fields[column.name];
                const result =
                    field.type === "many2many"
                        ? m2mCellToTags(cell, field, m2oMaps.get(column.name))
                        : cellToFieldValue(cell, field, m2oMaps.get(column.name));
                if (result.error) {
                    errors.push(
                        _t("Row %(row)s, %(column)s: %(error)s", {
                            row: rowNo,
                            column: column.label,
                            error: result.error,
                        })
                    );
                    rowError = true;
                    break;
                }
                // View-level read-only cells (static or per-record expression)
                // must not be changed; equal values pass so a re-imported
                // export does not error.
                if (target && this.o2mCellReadonly(target, column.name)) {
                    const same =
                        field.type === "many2many"
                            ? this._o2mM2mSame(target, column.name, result.value)
                            : isSameFieldValue(target, column.name, field, result.value);
                    if (!same) {
                        errors.push(
                            _t("Row %(row)s, %(column)s: the field is read-only.", {
                                row: rowNo,
                                column: column.label,
                            })
                        );
                        rowError = true;
                        break;
                    }
                    continue;
                }
                if (field.type === "many2many") {
                    m2mValues[column.name] = result.value;
                } else if (!target || !isSameFieldValue(target, column.name, field, result.value)) {
                    values[column.name] = result.value;
                }
            }
            if (rowError) {
                continue;
            }
            if (target) {
                let m2mChanged = false;
                for (const [name, tags] of Object.entries(m2mValues)) {
                    if (await this._o2mReplaceM2m(target, name, tags)) {
                        m2mChanged = true;
                    }
                }
                if (Object.keys(values).length) {
                    await target.update(values);
                }
                if (Object.keys(values).length || m2mChanged) {
                    updated++;
                }
            } else {
                const record = await list.addNewRecord({ position: "bottom", mode: "readonly" });
                // Cells whose column is read-only on the new line are dropped,
                // exactly like typing into the cell would be impossible.
                const allowed = {};
                for (const [name, value] of Object.entries(values)) {
                    if (!this.o2mCellReadonly(record, name)) {
                        allowed[name] = value;
                    }
                }
                if (Object.keys(allowed).length) {
                    await record.update(allowed);
                }
                for (const [name, tags] of Object.entries(m2mValues)) {
                    if (tags.length && !this.o2mCellReadonly(record, name)) {
                        await this._o2mReplaceM2m(record, name, tags);
                    }
                }
                created++;
            }
        }
        await list.leaveEditMode();

        const parts = [
            _t("%(updated)s line(s) updated, %(created)s line(s) created.", { updated, created }),
        ];
        if (updated || created) {
            parts.push(_t("The changes are staged on the form: review them and save the record."));
        }
        if (skipped.length) {
            parts.push(_t("Ignored columns: %s", skipped.join(", ")));
        }
        if (errors.length) {
            parts.push(errors.slice(0, 5).join("\n"));
            if (errors.length > 5) {
                parts.push(_t("... and %s more error(s).", errors.length - 5));
            }
        }
        this.o2mNotification.add(parts.join("\n"), {
            title: _t("Import finished"),
            type: errors.length ? (updated || created ? "warning" : "danger") : "success",
            sticky: errors.length > 0,
        });
    }

    async toggleO2mFilter() {
        const list = this.list;
        const state = this.o2mFilterState;
        if (state.active && !state.closing) {
            // Clear right away so the rows are restored while the bar slides up.
            state.cols = {};
            state.offset = 0;
            state.closing = true;
            this._closeTimer = browser.setTimeout(async () => {
                state.active = false;
                state.closing = false;
                if (this._origPaging) {
                    const { limit, offset } = this._origPaging;
                    this._origPaging = null;
                    await list.load({ limit, offset });
                }
            }, CLOSE_ANIMATION_MS);
        } else {
            browser.clearTimeout(this._closeTimer);
            state.active = true;
            state.closing = false;
            state.offset = 0;
            state.pageSize = this._origPaging ? this._origPaging.limit : list.limit;
            state.truncated = list.count > FULL_LOAD_LIMIT;
            // Load every page so the filter searches the whole recordset.
            if (list.count > list.records.length) {
                this._origPaging = this._origPaging || { limit: list.limit, offset: list.offset };
                await list.load({ limit: Math.min(list.count, FULL_LOAD_LIMIT), offset: 0 });
            }
        }
    }
}

registry.category("fields").add("one2many_enhanced", {
    ...x2ManyField,
    component: EnhancedOne2ManyField,
    displayName: _t("Relational table (enhanced)"),
});
