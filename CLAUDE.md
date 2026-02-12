# CLAUDE.md - Technical context for VIPER-Web

## What this is

A browser port of [VIPER](https://github.com/mzechmeister/viper) (Velocity and
IP Estimator). Runs Python in the browser via Pyodide (WebAssembly). No backend.
Single-spectrum, single-order CRIRES fitting only (no multi-file pipeline, no
template creation, no iodine cell mode).

## Architecture

**Two-layer design**: Python does all the math, JavaScript handles UI/files/plots.
They communicate via JSON strings through `pyodide.runPython()`.

- `app.js` calls `setup_model()` which returns a dict. The dict contains both
  JSON-serializable data (for plotting) and internal Python objects (prefixed
  with `_`, for use by `fit_order()`). The JS side only sees the JSON portion.
- The Python `result` variable persists in Pyodide's global scope between
  `runPython` calls, so `fit_order(result, ...)` can access the `_S_mod` model
  object, `_par` params, etc.
- All numpy arrays are converted to lists via `_safe_list()` which replaces
  NaN/Inf with `None` for valid JSON.

## Key source mapping from original VIPER

| Original | Web version | Changes |
|---|---|---|
| `viper.py` `fit_chunk()` | `python/fitting.py` | Extracted to `setup_model()` + `fit_order()`, no CLI/gplot |
| `utils/model.py` | `python/model.py` | Removed gplot imports, `show()` method, `show_model()` |
| `utils/param.py` | `python/param.py` | Verbatim |
| `utils/wstat.py` | `python/wstat.py` | Verbatim (docstrings trimmed) |
| `inst/inst_CRIRES.py` | `python/read_crires.py` | Astropy-only, no PyCPL, no SkyCoord/BERV computation |
| `inst/FTS_resample.py` | `python/fts_resample.py` | Added `make_fake_cell()` for nocell mode |
| `inst/airtovac.py` | `python/airtovac.py` | Verbatim |

## Design choices

- **BERV from header**: Original VIPER computes BERV via `astropy.coordinates.SkyCoord`
  which pulls in heavy deps and network calls. We read `ESO QC BERV` from the
  FITS header instead. Falls back to 0.0 if missing; user can override in the UI.
- **Nocell mode only**: The fake cell (`make_fake_cell()`) creates a flat unity
  spectrum. This replicates `viper.py` lines 789-794 when `ftsname=='None'`.
- **Atmosphere lazy-loading**: FITS files (7-17 MB each) are fetched on demand
  based on the observation wavelength range, then cached via the browser Cache API.
- **IP_sbg bug**: The original `IP_sbg` function references undefined variables
  `mu`, `s`, `a`. Fixed to use `s1` and `0` respectively.
- **`c` units**: `model.py` uses `c = 299792.458` km/s. `fts_resample.py` uses
  `c = 299792458` m/s. The `vcut` parameter in `fitting.py` is in km/s.
  Be careful not to mix these up.

## Pyodide specifics

- Python files are fetched as text and written to `/home/pyodide/` on the
  Pyodide virtual filesystem. That path is added to `sys.path`.
- Atmosphere FITS files go to `/home/pyodide/atmos/`.
- Uploaded FITS files go to `/home/pyodide/obs.fits` and `/home/pyodide/tpl.fits`.
- Packages installed via micropip: numpy, scipy, astropy.
- Pyodide version: 0.29.3 from jsDelivr CDN.

## Testing locally

```
uv run serve.py
```

Then open http://localhost:8000 and upload a CRIRES FITS file from
`/Users/tom/vipere.git/data/WASP18/cr2res_WASP18.fits`. Orders 1-27 are
available in that file (Y1029 setting).

The `atmos/` directory contains symlinks to `/Users/tom/vipere.git/lib/atmos/`.
These are gitignored; for deployment, the browser fetches them from the served
`atmos/` path.

## Testing Python modules standalone

```
cd /path/to/repo
uv run --with numpy --with scipy --with astropy python -c "
import sys; sys.path.insert(0, 'python')
from fitting import setup_model, fit_order
result = setup_model('path/to/obs.fits', order=10, atmos_dir='path/to/atmos', telluric='add')
fit = fit_order(result, kapsig=(0, 3))
print(fit['rv'], fit['e_rv'])
"
```

## What's not implemented (future phases from original plan)

- Multi-order fitting (loop orders, combine RVs)
- Web Worker for non-blocking fit (UI freezes during curve_fit)
- Additional instruments (only CRIRES reader exists)
- Template creation from observations
- Iodine cell mode
- Rational polynomial normalization (`pade()` exists but no UI toggle)
- `model_bnd` (band matrix non-parametric IP) -- code is in model.py but not wired up

## Gotchas

- The test FITS file (`cr2res_WASP18.fits`) has no `ESO QC BERV` header keyword,
  so BERV defaults to 0. The original VIPER computes it from coordinates.
- When no template is provided, RV is fixed (uncertainty = 0). This is correct
  behavior -- you need stellar lines to measure a velocity.
- The `atmos/*.fits` files are NOT in the git repo (gitignored). For the GitHub
  Pages deployment, they need to be served somehow -- currently the browser
  fetches from `atmos/` relative path, which works locally but not on Pages
  unless the files are committed or hosted elsewhere.
