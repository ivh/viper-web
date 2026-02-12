# VIPER-Web

**[Launch VIPER-Web](https://ivh.github.io/viper-web/)**

Browser-based telluric spectrum fitter for CRIRES observations. Everything runs
client-side using [Pyodide](https://pyodide.org/) (Python in WebAssembly) --
no server, no installation required.

This is a web port of [VIPER](https://github.com/mzechmeister/viper) (Velocity
and IP Estimator) by Mathias Zechmeister and Jana Koehler. The original VIPER is
a full-featured Python CLI for fitting telluric spectra and measuring radial
velocities. VIPER-Web extracts the single-spectrum fitting workflow and makes it
accessible through a browser UI.

## What it does

- Upload a CRIRES FITS observation (and optionally a stellar template)
- Select an order (1-28) and configure the forward model
- Fit telluric absorption lines with selectable molecules (H2O, CH4, N2O, CO2, CO, O2)
- Choose instrumental profile shape (Gaussian, super-Gaussian, asymmetric, bi-Gaussian, etc.)
- Iterative least-squares fitting with kappa-sigma clipping
- Interactive Plotly plots: spectrum + model, residuals, IP shape
- Export results as JSON, CSV, or PNG

## How to use

1. Open https://ivh.github.io/viper-web/
2. Wait for Pyodide and packages (numpy, scipy, astropy) to load (~15s)
3. Upload a CRIRES FITS file
4. Adjust order number and model settings in the sidebar
5. Click **Load & Plot** to see the raw spectrum and initial model
6. Click **Fit** to run the least-squares fit
7. Results (RV, uncertainties, %rms) appear above the plots

The atmosphere model files (~10-17 MB per band) are fetched on demand and cached
in the browser for subsequent visits.

## Local development

```
git clone https://github.com/ivh/viper-web.git
cd viper-web
uv run serve.py
```

The `atmos/` directory should contain (or symlink to) the standard atmosphere
FITS files from the VIPER repository (`lib/atmos/stdAtmos_*.fits`).

## Project structure

```
index.html          UI (single page, dark theme)
app.js              Pyodide init, file handling, Plotly rendering
serve.py            Local dev server
python/
  fitting.py        Main entry: setup_model(), fit_order()
  model.py          Forward model + IP functions
  param.py          Parameter classes
  wstat.py          Weighted statistics
  read_crires.py    CRIRES FITS reader
  fts_resample.py   Log-wavelength resampling
  airtovac.py       Air-to-vacuum wavelength conversion
atmos/              Atmosphere model FITS files (not in repo)
```

## Credits

VIPER-Web is derived from **[VIPER](https://github.com/mzechmeister/viper)**
(Velocity and IP Estimator), developed by **Mathias Zechmeister** and **Jana
Koehler** at the University of Goettingen. The forward model, instrumental
profile functions, parameter system, and fitting logic are ported directly from
VIPER. All scientific credit belongs to the original authors.

If you use results from this tool, please cite the original VIPER repository
and the authors' work.

## License

Licensed under GPLv3, following the original VIPER license.
