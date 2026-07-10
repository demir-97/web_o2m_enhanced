import { rpcBus } from "@web/core/network/rpc";
import { UPDATE_METHODS } from "@web/core/orm_service";

// get_views responses are cached on disk by the view service, and only
// writes on ir.ui.view / ir.filters invalidate that cache. A table setup
// changes the postprocessed archs too, so it must invalidate it the same way
// (otherwise the change only shows up after the background revalidation).
rpcBus.addEventListener("RPC:RESPONSE", (ev) => {
    const { model, method } = ev.detail.data.params;
    if (model === "o2m.enhanced.config" && UPDATE_METHODS.includes(method)) {
        rpcBus.trigger("CLEAR-CACHES", "get_views");
    }
});
