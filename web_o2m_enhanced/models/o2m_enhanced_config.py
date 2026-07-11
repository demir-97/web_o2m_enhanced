from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

# Boolean flags copied 1:1 into the widget's options dict when set.
OPTION_FLAGS = (
    'default_open',
    'disable_filter',
    'disable_export',
    'disable_import',
    'disable_bulk_edit',
    'disable_duplicate',
    'disable_selection',
    'disable_hierarchy',
)


class O2mEnhancedConfig(models.Model):
    """No-code setup of the one2many_enhanced widget.

    Each record enables the widget (with the chosen options) on one one2many
    field, in every form view displaying it, without touching any view XML.
    The injection happens in ir.ui.view._postprocess_tag_field().
    """
    _name = 'o2m.enhanced.config'
    _description = 'Enhanced Table Setup'
    _order = 'model_name, field_name'

    active = fields.Boolean(default=True)
    model_id = fields.Many2one(
        'ir.model', string='Model', required=True, ondelete='cascade',
        help="Model whose form views contain the one2many table "
             "(e.g. Sales Order for its order lines).")
    model_name = fields.Char(
        related='model_id.model', store=True, string='Model Name')
    field_id = fields.Many2one(
        'ir.model.fields', string='Table', required=True, ondelete='cascade',
        domain="[('model_id', '=', model_id), ('ttype', '=', 'one2many')]",
        help="The one2many field displayed as an embedded table in the form.")
    field_name = fields.Char(related='field_id.name', store=True)
    line_model = fields.Char(related='field_id.relation', string='Line Model')
    force_widget = fields.Boolean(
        string="Override Custom Widget",
        help="Some tables are displayed with a specialized widget (e.g. the "
             "sale order lines and their sections & notes). Enable this to "
             "replace it with the enhanced table anyway; the specialized "
             "widget's own features will not be available.")
    custom_widget_warning = fields.Char(compute='_compute_custom_widget_warning')

    default_open = fields.Boolean(
        string="Open Filters by Default",
        help="Show the filter row as soon as the form is displayed.")
    save_column_widths = fields.Boolean(
        string="Remember Column Widths", default=True,
        help="Column widths resized by dragging are restored per user after a refresh.")
    disable_filter = fields.Boolean(string="Disable Column Filters")
    disable_export = fields.Boolean(string="Disable Excel Export")
    disable_import = fields.Boolean(
        string="Disable Import & Paste",
        help="Hides both the file import and the paste-from-Excel tools.")
    disable_selection = fields.Boolean(
        string="Disable Row Selection",
        help="Hides the row checkboxes; bulk edit and duplication need them, "
             "so they are disabled as well.")
    disable_bulk_edit = fields.Boolean(string="Disable Bulk Edit")
    disable_duplicate = fields.Boolean(string="Disable Line Duplication")
    disable_hierarchy = fields.Boolean(string="Disable Hierarchy View")
    hierarchy_field_id = fields.Many2one(
        'ir.model.fields', string='Hierarchy Field', ondelete='set null',
        domain="[('model', '=', line_model), ('ttype', '=', 'many2one'),"
               " ('relation', '=', line_model)]",
        help="Parent-line field used by the hierarchy view. "
             "Leave empty to auto-detect it.")
    no_filter_column_ids = fields.Many2many(
        'ir.model.fields', 'o2m_enhanced_config_no_filter_rel',
        'config_id', 'field_id', string='Columns Without Filter',
        domain="[('model', '=', line_model)]",
        help="These columns get no input in the filter row.")

    _sql_constraints = [
        ('field_uniq', 'unique(field_id)',
         "There is already a setup for this one2many field."),
    ]

    @api.depends('model_id.name', 'field_id.field_description')
    def _compute_display_name(self):
        for config in self:
            if config.model_id and config.field_id:
                config.display_name = f"{config.model_id.name} - {config.field_id.field_description}"
            else:
                config.display_name = _("New Table Setup")

    @api.depends('model_id', 'field_id', 'force_widget')
    def _compute_custom_widget_warning(self):
        for config in self:
            config.custom_widget_warning = False
            model_name = config.model_id.model
            field_name = config.field_id.name
            if not model_name or not field_name or model_name not in self.env:
                continue
            widgets = config._find_custom_widgets(model_name, field_name)
            if not widgets:
                continue
            names = ", ".join(sorted(widgets))
            if config.force_widget:
                config.custom_widget_warning = _(
                    'This table is normally displayed with the specialized widget "%s". '
                    'It will be replaced by the enhanced table: the specialized widget\'s '
                    'own features (e.g. sections and notes) will not be available.', names)
            else:
                config.custom_widget_warning = _(
                    'This table is displayed with the specialized widget "%s", so this '
                    'setup will not apply there. Enable "Override Custom Widget" to '
                    'replace it anyway.', names)

    def _find_custom_widgets(self, model_name, field_name):
        """Names of non-standard widgets displaying `field_name` in the
        model's form views (combined archs, before any widget injection)."""
        widgets = set()
        views = self.env['ir.ui.view'].sudo().search([
            ('model', '=', model_name),
            ('type', '=', 'form'),
            ('mode', '=', 'primary'),
            ('active', '=', True),
        ])
        Model = self.env[model_name]
        for view in views:
            try:
                arch, _view = Model._get_view(view.id, 'form')
            except Exception:
                continue
            for node in arch.iter('field'):
                widget = node.get('widget')
                if (
                    node.get('name') == field_name
                    and widget
                    and widget not in ('one2many', 'one2many_enhanced')
                ):
                    widgets.add(widget)
        return widgets

    @api.constrains('model_id', 'field_id')
    def _check_field(self):
        for config in self:
            if config.field_id.model_id != config.model_id or config.field_id.ttype != 'one2many':
                raise ValidationError(
                    _("The field must be a one2many field of the selected model."))

    @api.onchange('model_id')
    def _onchange_model_id(self):
        self.field_id = False

    @api.onchange('field_id')
    def _onchange_field_id(self):
        self.hierarchy_field_id = False
        self.no_filter_column_ids = False

    def _get_widget_options(self):
        """The options dict for the field tag, like an XML options="{...}"."""
        self.ensure_one()
        options = {flag: True for flag in OPTION_FLAGS if self[flag]}
        if not self.save_column_widths:
            options['save_column_widths'] = False
        if self.hierarchy_field_id:
            options['hierarchy_field'] = self.hierarchy_field_id.name
        if self.no_filter_column_ids:
            options['no_filter_columns'] = self.no_filter_column_ids.mapped('name')
        return options

    # Postprocessed view archs are cached (ormcache "templates"): any setup
    # change must invalidate them to be visible on the next form load.

    @api.model_create_multi
    def create(self, vals_list):
        configs = super().create(vals_list)
        self.env.registry.clear_cache('templates')
        return configs

    def write(self, vals):
        result = super().write(vals)
        self.env.registry.clear_cache('templates')
        return result

    def unlink(self):
        result = super().unlink()
        self.env.registry.clear_cache('templates')
        return result
