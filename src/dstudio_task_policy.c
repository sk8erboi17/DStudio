/* DStudio Task Graph V1 — built-in policy registry. */

typedef struct {
    const char *name;
    int strict_by_default;
    int allow_external_side_effects;
} dtg_policy_descriptor;

static const dtg_policy_descriptor DTG_POLICIES[] = {
    { "agent.general.v1", 1, 1 },
    { "plan.v1",          1, 0 },
    { "test.synthetic.v1", 0, 0 },
};

static const dtg_policy_descriptor *dtg_policy_find(const char *name) {
    for (size_t i = 0; i < sizeof DTG_POLICIES / sizeof DTG_POLICIES[0]; i++)
        if (!strcmp(DTG_POLICIES[i].name, name)) return &DTG_POLICIES[i];
    return NULL;
}

static int dtg_executor_kind_registered(dtg_node_kind kind) {
    return kind == DTG_NODE_AGENT_TURN || kind == DTG_NODE_HOST_TOOL ||
           kind == DTG_NODE_GATE || kind == DTG_NODE_APPROVAL ||
           kind == DTG_NODE_JOIN;
}

static int dtg_node_has_capability(const dtg_node *node, const char *capability) {
    for (size_t i = 0; node && i < node->capability_count; i++)
        if (!strcmp(node->capabilities[i], capability)) return 1;
    return 0;
}

static int dtg_node_has_only_capability(const dtg_node *node, const char *capability) {
    return node && node->capability_count == 1 &&
           !strcmp(node->capabilities[0], capability);
}

static int dtg_native_action_policy(const dtg_graph *graph, const dtg_node *node,
                                    char *err, size_t errsz) {
    const char *action = node ? node->action_name : "";
    if (!node || !action[0]) {
        snprintf(err, errsz, "native node '%s' has no bounded action",
                 node ? node->id : "missing"); return 0;
    }
    if (!strcmp(action, "agent.prompt")) {
        if (node->kind != DTG_NODE_AGENT_TURN || !node->action_text || !node->action_text[0]) {
            snprintf(err, errsz, "action agent.prompt requires an agent_turn and non-empty text"); return 0;
        }
        if (node->action_require_tool_result &&
            (!node->action_expect || !node->action_expect[0])) {
            snprintf(err, errsz,
                     "agent.prompt requireToolResult also requires a completion marker");
            return 0;
        }
        if (node->mutation == DTG_MUTATION_READ_ONLY &&
            dtg_node_has_capability(node, "filesystem.write")) {
            snprintf(err, errsz, "read-only agent.prompt cannot request filesystem.write"); return 0;
        }
        if (node->mutation == DTG_MUTATION_WORKSPACE_WRITE &&
            !dtg_node_has_capability(node, "filesystem.write")) {
            snprintf(err, errsz, "workspace-writing agent.prompt requires filesystem.write"); return 0;
        }
        for (size_t i = 0; i < node->capability_count; i++) {
            const char *cap = node->capabilities[i];
            if (node->mutation == DTG_MUTATION_READ_ONLY &&
                strcmp(cap, "filesystem.read") && strcmp(cap, "git.read") &&
                strcmp(cap, "artifact.register")) {
                snprintf(err, errsz, "read-only agent.prompt requests mutating or external capability '%s'", cap); return 0;
            }
            if (node->mutation != DTG_MUTATION_EXTERNAL_SIDE_EFFECT &&
                (!strcmp(cap, "network") || !strcmp(cap, "browser"))) {
                snprintf(err, errsz, "agent.prompt requires external_side_effect for capability '%s'", cap); return 0;
            }
        }
        if (node->mutation == DTG_MUTATION_EXTERNAL_SIDE_EFFECT &&
            (!graph->approval_required ||
             (!dtg_node_has_capability(node, "network") && !dtg_node_has_capability(node, "browser")))) {
            snprintf(err, errsz, "external agent.prompt requires graph approval and network or browser capability"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "agent.receipt.verify")) {
        if (node->kind != DTG_NODE_GATE || node->mutation != DTG_MUTATION_READ_ONLY ||
            !dtg_node_has_only_capability(node, "filesystem.read") ||
            node->dependency_count != 1) {
            snprintf(err, errsz,
                     "agent.receipt.verify requires a read-only gate, filesystem.read and one dependency");
            return 0;
        }
        const dtg_node *source = dtg_find_node_const(graph, node->dependencies[0].node_id);
        if (!source || strcmp(source->action_name, "agent.prompt") ||
            !source->action_expect || !source->action_expect[0]) {
            snprintf(err, errsz,
                     "agent.receipt.verify dependency must be an agent.prompt with a completion marker");
            return 0;
        }
        return 1;
    }
    if (!strcmp(action, "workspace.read")) {
        if (node->kind != DTG_NODE_HOST_TOOL || node->mutation != DTG_MUTATION_READ_ONLY ||
            !node->action_path[0] || !dtg_relative_path_valid(node->action_path) ||
            !dtg_node_has_only_capability(node, "filesystem.read")) {
            snprintf(err, errsz, "workspace.read requires host_tool, read_only, filesystem.read and a relative path"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "workspace.write")) {
        if (node->kind != DTG_NODE_HOST_TOOL || node->mutation != DTG_MUTATION_WORKSPACE_WRITE ||
            !node->action_path[0] || !dtg_relative_path_valid(node->action_path) ||
            !node->action_text || !dtg_node_has_only_capability(node, "filesystem.write")) {
            snprintf(err, errsz, "workspace.write requires host_tool, workspace_write, filesystem.write, path and text"); return 0;
        }
        if (!strncmp(node->action_path, ".dstudio/", 9) || !strcmp(node->action_path, ".dstudio")) {
            snprintf(err, errsz, "workspace.write cannot modify Task Graph control storage"); return 0;
        }
        if (strlen(node->action_text) > node->action_max_bytes) {
            snprintf(err, errsz, "workspace.write text exceeds action maxBytes"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "test.run")) {
        if (node->kind != DTG_NODE_HOST_TOOL || node->mutation != DTG_MUTATION_WORKSPACE_WRITE ||
            !node->action_argc || !node->action_argv[0][0] ||
            !dtg_node_has_only_capability(node, "test.run")) {
            snprintf(err, errsz, "test.run requires host_tool, workspace_write, test.run and non-empty argv"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "workspace.assert")) {
        if (node->kind != DTG_NODE_GATE || node->mutation != DTG_MUTATION_READ_ONLY ||
            !node->action_path[0] || !dtg_relative_path_valid(node->action_path) ||
            !dtg_node_has_only_capability(node, "filesystem.read")) {
            snprintf(err, errsz, "workspace.assert requires gate, read_only, filesystem.read and a relative path"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "outputs.verify")) {
        if (node->kind != DTG_NODE_GATE || node->mutation != DTG_MUTATION_READ_ONLY ||
            !dtg_node_has_only_capability(node, "filesystem.read")) {
            snprintf(err, errsz, "outputs.verify requires gate, read_only and filesystem.read"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "approval.wait")) {
        if (node->kind != DTG_NODE_APPROVAL || node->mutation != DTG_MUTATION_READ_ONLY ||
            node->capability_count) {
            snprintf(err, errsz, "approval.wait requires a read-only approval node"); return 0;
        }
        return 1;
    }
    if (!strcmp(action, "join.all")) {
        if (node->kind != DTG_NODE_JOIN || node->mutation != DTG_MUTATION_READ_ONLY ||
            node->capability_count) {
            snprintf(err, errsz, "join.all requires a read-only join node"); return 0;
        }
        return 1;
    }
    snprintf(err, errsz, "native action '%s' is not registered", action);
    return 0;
}

static unsigned long long dtg_fnv1a64_bytes(unsigned long long hash,
                                             const void *data, size_t len) {
    const unsigned char *p = (const unsigned char *)data;
    if (!hash) hash = 1469598103934665603ULL;
    for (size_t i = 0; i < len; i++) { hash ^= p[i]; hash *= 1099511628211ULL; }
    return hash;
}

static int dtg_policy_digest(const dtg_graph *graph, char out[17]) {
    json_dyn_buf canonical = {0};
    if (!dtg_graph_definition_json(graph, &canonical)) return 0;
    unsigned long long hash = dtg_fnv1a64_bytes(0, canonical.ptr, canonical.len);
    free(canonical.ptr);
    snprintf(out, 17, "%016llx", hash);
    return 1;
}

static int dtg_policy_validate(const dtg_graph *graph, int requested_strict,
                               char *err, size_t errsz) {
    const dtg_policy_descriptor *policy = graph ? dtg_policy_find(graph->policy) : NULL;
    if (!policy) { snprintf(err, errsz, "task graph policy is not registered"); return 0; }
    int strict = requested_strict || policy->strict_by_default;
    if (!dtg_validate_graph(graph, strict, err, errsz)) return 0;
    for (size_t i = 0; i < graph->node_count; i++) {
        const dtg_node *node = &graph->nodes[i];
        if (!dtg_executor_kind_registered(node->kind)) {
            snprintf(err, errsz, "node '%s' has no registered executor", node->id);
            return 0;
        }
        if (!policy->allow_external_side_effects &&
            node->mutation == DTG_MUTATION_EXTERNAL_SIDE_EFFECT) {
            snprintf(err, errsz, "policy '%s' forbids external side effects", policy->name);
            return 0;
        }
        if (!strcmp(policy->name, "plan.v1") && node->state != DTG_NODE_DRAFT) {
            snprintf(err, errsz, "Plan graph proposals must contain only draft nodes");
            return 0;
        }
        if (!strcmp(graph->executor_mode, "native") &&
            !dtg_native_action_policy(graph, node, err, errsz)) return 0;
    }
    return 1;
}
