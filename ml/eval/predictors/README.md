# Extra eval predictors

Each `*.py` here is auto-imported by `ml/eval/harness.py` and must define `register(h)`, calling
`h.register(h.Family(name, tasks, predict, setup=None))`. `predict(env)` returns a list of
`h.Pred(task, name, ranked, abstain=False)`, where `ranked` is `[(label, confidence_0_100), ...]`.
`env` holds `data`, `trip`, `ctx` (serve context, incl. `hist`), `replay`, `state`, `tasks`, `so_far`.
Run one family quickly: `python3 ml/eval/harness.py ... --task end --only <name>`.
