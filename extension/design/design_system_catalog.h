#ifndef DSTUDIO_DESIGN_SYSTEM_CATALOG_H
#define DSTUDIO_DESIGN_SYSTEM_CATALOG_H
#include <string.h>

/* One catalog for the app, native pack loader and build-time bundle checks.
 * Legacy downloaded folders are never exposed, even on an older install. */
static const char *const dstudio_design_system_ids[] = {
    "folio", "signal", "forma", "grove", "pulse", NULL
};
static int dstudio_design_system_supported(const char *id) {
    if (!id) return 0;
    for (int i = 0; dstudio_design_system_ids[i]; i++)
        if (!strcmp(id, dstudio_design_system_ids[i])) return 1;
    return 0;
}
#endif
