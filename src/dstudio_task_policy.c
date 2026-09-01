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
    }
    return 1;
}
