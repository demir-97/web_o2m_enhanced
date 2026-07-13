/** @odoo-module **/
import { registry } from "@web/core/registry";
import { UPDATE_METHODS } from "@web/core/orm_service";

// get_views responses are cached by the view service, and only writes on
// ir.ui.view / ir.filters invalidate that cache. A table setup changes the
// postprocessed archs too, so it must invalidate it the same way (otherwise
// the change only shows up after a full page reload).
//
// Odoo 17 has no dedicated `rpcBus`; the rpc service fires "RPC:RESPONSE" on
// the main env bus (settings.bus = env.bus), so we listen there.
const o2mEnhancedViewCacheInvalidation = {
    start(env) {
        env.bus.addEventListener("RPC:RESPONSE", (ev) => {
            const { model, method } = ev.detail.data.params;
            if (model === "o2m.enhanced.config" && UPDATE_METHODS.includes(method)) {
                env.bus.trigger("CLEAR-CACHES");
            }
        });
    },
};

registry
    .category("services")
    .add("web_o2m_enhanced.view_cache_invalidation", o2mEnhancedViewCacheInvalidation);
