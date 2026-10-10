from odoo import models
from odoo.tools.safe_eval import safe_eval


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    def _postprocess_tag_field(self, node, name_manager, node_info):
        result = super()._postprocess_tag_field(node, name_manager, node_info)
        # After super: for widget-less x2many fields the core has already
        # embedded a default list arch, which the enhanced widget needs too.
        # one2many and many2many both resolve to core's x2ManyField, so the
        # embedded arch -- and therefore the enhanced widget -- fits either.
        name = node.get('name')
        if name and node_info.get('view_type') == 'form':
            field = name_manager.model._fields.get(name)
            if field is not None and field.type in ('one2many', 'many2many'):
                self._o2m_enhanced_apply_config(node, name_manager.model._name, name)
        return result

    def _o2m_enhanced_apply_config(self, node, model_name, field_name):
        """Enable the enhanced widget on `node` when a UI setup exists."""
        config = self.env['o2m.enhanced.config'].sudo().search(
            [('model_name', '=', model_name), ('field_name', '=', field_name)],
            limit=1,
        )
        if not config:
            return
        # A custom widget (e.g. the sale order lines' section_and_note_one2many)
        # is only replaced when the setup explicitly asks for it.
        if (
            node.get('widget') not in (
                None, '', 'one2many', 'many2many', 'one2many_enhanced',
            )
            and not config.force_widget
        ):
            return
        # The enhanced table renders the list arch embedded in the node.
        # Core embeds a default one only for a field the view leaves
        # widget-less; a field declaring widget="many2many_tags" (or any
        # other non-list widget) has none, and swapping the widget in there
        # would leave the table with nothing to draw. Measured on 19: a
        # widget-less many2many gets name/parent_id/color, while
        # many2many and many2many_tags get nothing.
        if node.find('list') is None and node.find('tree') is None:
            return
        options = config._get_widget_options()
        if node.get('options'):
            try:
                # Options written in the view XML keep precedence over the
                # UI setup: a developer choice stays a deliberate one.
                options.update(safe_eval(node.get('options')))
            except Exception:
                # Not statically evaluable: keep the node's own options.
                options = None
        node.set('widget', 'one2many_enhanced')
        if options:
            node.set('options', repr(options))
