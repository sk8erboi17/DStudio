/* Included at the modern Agent's generation loop, where w is the owner.
 * The transaction restores PLD snapshots first; upstream then rebuilds any
 * invalidated compact/recurrent cache before the next generated token.
 * pld_agent.inc undefines this loop-local macro after use. */
#define DS4UI_AGENT_PLD_REWIND(session, tx, pos, error, length) \
    (ds4ui_pld_rewind((session), (tx), (pos), (error), (length)) != 0 ? -1 : \
     agent_worker_rewind(w, (pos), (error), (length)))
