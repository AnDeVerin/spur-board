# Stand roles

- `operator` carries the stand's operator token and no session.
- `worker` carries a session of the worker project `stand-worker`; `orchestrator` a session of
  `stand-qa`, the orchestrator of the stand's `qa` column, and of Review in the `dispatch-*`
  scenarios; also of Product Review and Ready to Merge in `dispatch-new-head-in-ready-to-merge`
  and `dispatch-ci-red-new-head-in-product-review`.
- `curator` carries a session of `stand-curator`, the stand project's curator only in the curator
  scenarios; elsewhere its calls are refused.
- After `dispatch-dead-executor`, `--as worker` answers `forbidden`: its session is killed.
- After `curator-absent`, the curator session is killed.
