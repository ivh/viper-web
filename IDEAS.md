# Ideas

## Global telluric fit across all orders -- DONE (aa8a290, 2026-02-13)

Implemented as `setup_multi_order()` / `fit_multi_order()` in `python/fitting.py`,
exposed in the UI as the "All orders" fit mode. Shares `rv` and `atm` across
orders, keeps `norm`, `wave`, `ip` per order, one `curve_fit` on the
concatenated pixel vector.
