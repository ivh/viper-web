# Ideas

## Global telluric fit across all orders

Original VIPER fits each order independently, so each gets its own atmosphere
scaling coefficients. But it's the same atmosphere — a global fit would be
physically more correct and better constrained.

Approach: set up each order's model independently (wavelength, normalization,
IP), concatenate good pixels from all orders into one big vector, build a
combined model function that shares the atmosphere coefficients but uses
per-order `norm`, `wave`, `ip` parameters. One `curve_fit` call on the whole
thing. The `Params` nested dict already supports this with keys like
`norm_o10`, `wave_o10`, etc.
