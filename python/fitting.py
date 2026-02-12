#! /usr/bin/env python3
# Licensed under a GPLv3 style license - see LICENSE
# Core fitting logic extracted from viper.py fit_chunk()

import math
import numpy as np
from astropy.io import fits

from read_crires import read_spectrum, read_template, scan_fits_header
from fts_resample import make_fake_cell
from param import Params, param
from model import model, IPs, poly, pade, c


def _sanitize(v):
    '''Replace NaN/Inf with None for JSON serialization.'''
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def _safe_list(arr):
    '''Convert numpy array to JSON-safe list.'''
    return [_sanitize(float(x)) for x in arr]


class nameddict(dict):
    __getattr__ = dict.__getitem__
    def translate(self, x):
        return [name for name, f in self.items() if (f & x) or f == x == 0]


flag = nameddict(
    ok=0, nan=1, neg=2, sat=4, atm=8, sky=16, out=32,
    clip=64, lowQ=128, badT=256, chunk=512,
)


def setup_model(obs_path, order, tpl_path=None, atmos_dir='/home/pyodide/atmos',
                molecules=None, telluric='add', tellshift=False,
                deg_norm=3, deg_wave=3, ip_type='g', ip_hs=50,
                rv_guess=1.0, vcut=100, berv_override=None):
    '''
    Read data, build the forward model, and return initial-guess evaluation.

    Returns a dict with arrays for plotting + the model object for fitting.
    '''
    # --- read observation ---
    pixel, wave_obs, spec_obs, err_obs, flag_obs, berv, dateobs = read_spectrum(obs_path, order)

    if berv_override is not None:
        berv = berv_override

    flag_obs[np.isnan(spec_obs)] |= flag.nan

    # --- read or create template ---
    if tpl_path:
        wave_tpl, spec_tpl = read_template(tpl_path, order)
    else:
        wave_tpl = np.array([wave_obs[0] - 100, wave_obs[-1] + 100])
        spec_tpl = np.ones(2)

    # --- create fake cell (nocell mode) ---
    wave_cell, spec_cell, lnwave_j_full, spec_cell_j_full = make_fake_cell(
        min(wave_obs[0], wave_obs[-1]) - 200,
        max(wave_obs[0], wave_obs[-1]) + 200,
        len(pixel)
    )

    # --- wavelength range ---
    lmin = max(wave_obs[0], wave_tpl[0], wave_cell[0])
    lmax = min(wave_obs[-1], wave_tpl[-1], wave_cell[-1])

    flag_obs[np.log(wave_obs) < np.log(lmin) + vcut / c] |= flag.out
    flag_obs[np.log(wave_obs) > np.log(lmax) - vcut / c] |= flag.out

    sj = slice(*np.searchsorted(lnwave_j_full, np.log([lmin, lmax])))
    lnwave_j = lnwave_j_full[sj]
    spec_cell_j = spec_cell_j_full[sj]

    # --- preclip upper outliers (cosmics) ---
    i_valid = flag_obs == 0
    if np.any(i_valid):
        p17, smod, p83 = np.percentile(spec_obs[i_valid], [17, 50, 83])
        sig_est = (p83 - p17) / 2
        flag_obs[spec_obs > smod + 6 * sig_est] |= flag.clip

    # --- select good pixels ---
    i_ok = np.where(flag_obs == 0)[0]
    pixel_ok = pixel[i_ok]
    wave_obs_ok = wave_obs[i_ok]
    spec_obs_ok = spec_obs[i_ok]

    xcen = np.nanmean(pixel_ok) + 18

    # --- atmosphere / tellurics ---
    specs_molec = []
    par_atm = []

    if 'add' in telluric:
        specs_molec, par_atm = _load_atmosphere(
            lnwave_j, lmin, lmax, wave_obs, atmos_dir,
            molecules=molecules, tellshift=tellshift
        )

    # --- stellar template as interpolation function ---
    if tpl_path:
        S_star = lambda x: np.interp(x, np.log(wave_tpl) - np.log(1 + berv / c), spec_tpl)
    else:
        S_star = lambda x: 0 * x + 1

    IP_func = IPs[ip_type]

    modset = {'xcen': xcen, 'IP_hs': ip_hs}
    S_mod = model(S_star, lnwave_j, spec_cell_j, specs_molec, IP_func, **modset)

    # --- initial parameter set ---
    par = Params()
    par.rv = (rv_guess, 0) if not tpl_path else rv_guess
    norm_guess = np.nanmean(spec_obs_ok) / np.nanmean(S_star(np.log(wave_obs_ok))) / np.nanmean(spec_cell_j)
    par.norm = [norm_guess] + [0] * deg_norm
    par.wave = np.polyfit(pixel_ok - xcen, wave_obs_ok, deg_wave)[::-1]
    par.ip = [1.5]

    if ip_type in ('sg', 'mg', 'asg'):
        par.ip += [2.]
    elif ip_type in ('ag', 'agr'):
        par.ip += [1.]
    elif ip_type == 'bg':
        par.ip += [par.ip[-1]]

    par.atm = par_atm
    par.bkg = [(0, 0)]

    # --- evaluate initial model ---
    try:
        model_flux = S_mod(pixel_ok, **par)
        residuals = spec_obs_ok - model_flux
    except Exception as e:
        model_flux = np.zeros_like(spec_obs_ok)
        residuals = spec_obs_ok.copy()

    # --- atmosphere for plotting ---
    atm_flux = None
    if len(specs_molec):
        atm_flux = np.nanprod(specs_molec, axis=0)

    return {
        'pixel': _safe_list(pixel),
        'wave': _safe_list(wave_obs),
        'spec': _safe_list(spec_obs),
        'err': _safe_list(err_obs),
        'flag': flag_obs.tolist(),
        'pixel_ok': _safe_list(pixel_ok),
        'wave_ok': _safe_list(wave_obs_ok),
        'spec_ok': _safe_list(spec_obs_ok),
        'model_flux': _safe_list(model_flux),
        'residuals': _safe_list(residuals),
        'lnwave_j': _safe_list(lnwave_j),
        'atm_flux': _safe_list(atm_flux) if atm_flux is not None else None,
        'ip_vk': _safe_list(S_mod.vk),
        'ip_shape': _safe_list(IP_func(S_mod.vk, *par.ip)),
        'berv': _sanitize(float(berv)),
        'dateobs': str(dateobs),
        'xcen': float(xcen),
        # pass objects for fitting stage
        '_S_mod': S_mod,
        '_par': par,
        '_pixel': pixel,
        '_wave_obs': wave_obs,
        '_spec_obs': spec_obs,
        '_err_obs': err_obs,
        '_flag_obs': flag_obs,
        '_parguess_wave': par.wave[:],
        '_has_template': tpl_path is not None,
    }


def fit_order(setup_result, kapsig=(0, 3), deg_norm=3, deg_wave=3,
              ip_type='g', rv_guess=None, tellshift=False, wgt=''):
    '''
    Run the fitting on an already-setup model.

    Parameters
    ----------
    setup_result : dict
        Output from setup_model (must contain _ prefixed internal objects).
    kapsig : tuple
        Kappa-sigma clipping stages (pre-fit, post-fit). 0 = no clipping.
    '''
    S_mod = setup_result['_S_mod']
    par = Params(setup_result['_par'])
    pixel = setup_result['_pixel']
    wave_obs = setup_result['_wave_obs']
    spec_obs = setup_result['_spec_obs']
    err_obs = setup_result['_err_obs']
    flag_obs = setup_result['_flag_obs'].copy()
    parguess_wave = setup_result['_parguess_wave']

    if rv_guess is not None and setup_result.get('_has_template', False):
        par.rv = rv_guess

    # --- weighting ---
    sig = err_obs.copy() if wgt == 'error' else np.ones_like(spec_obs)

    i_ok = np.where(flag_obs == 0)[0]
    pixel_ok = pixel[i_ok]
    spec_obs_ok = spec_obs[i_ok]

    IP_func = S_mod.IP

    # --- optional Gaussian prefit for non-Gaussian IP types ---
    if ip_type in ('sg', 'ag', 'agr', 'bg'):
        S_modg = model(S_mod.S_star, S_mod.lnwave_j, S_mod.spec_cell_j,
                       S_mod.fluxes_molec, IPs['g'],
                       xcen=S_mod.xcen, IP_hs=S_mod.IP_hs)
        par1 = Params(par, ip=par.ip[0:1])
        try:
            par2, _ = S_modg.fit(pixel_ok, spec_obs_ok, par1, sig=sig[i_ok])
            par = par + par2.flat()
        except Exception:
            pass

    par3 = Params(par)

    # --- first kappa-sigma clipping ---
    if kapsig[0]:
        try:
            smod = S_mod(pixel, **par3)
            resid = spec_obs - smod
            resid[flag_obs != 0] = np.nan
            flag_obs[abs(resid) >= (kapsig[0] * np.nanstd(resid))] |= 64  # flag.clip
        except Exception:
            pass

        i_ok = np.where(flag_obs == 0)[0]
        pixel_ok = pixel[i_ok]
        spec_obs_ok = spec_obs[i_ok]

    # --- main fit ---
    par.wave = parguess_wave
    try:
        par4, e_params = S_mod.fit(pixel_ok, spec_obs_ok, par, sig=sig[i_ok])
        par = par4
    except Exception as e:
        return {
            'error': f'Fit failed: {str(e)}',
            'converged': False,
        }

    # --- second kappa-sigma clipping + refit ---
    if kapsig[-1]:
        try:
            smod = S_mod(pixel, **par)
            resid = spec_obs - smod
            resid[flag_obs != 0] = np.nan

            nr_k1 = np.count_nonzero(flag_obs)
            flag_obs[abs(resid) >= (kapsig[-1] * np.nanstd(resid))] |= 64
            nr_k2 = np.count_nonzero(flag_obs)

            if nr_k1 != nr_k2:
                i_ok = np.where(flag_obs == 0)[0]
                pixel_ok = pixel[i_ok]
                spec_obs_ok = spec_obs[i_ok]

                par5, e_params = S_mod.fit(pixel_ok, spec_obs_ok, par3, sig=sig[i_ok])
                par = par5
        except Exception:
            pass

    # --- compute final model and results ---
    i_ok = np.where(flag_obs == 0)[0]
    pixel_ok = pixel[i_ok]
    wave_obs_ok = wave_obs[i_ok]
    spec_obs_ok = spec_obs[i_ok]

    fmod = S_mod(pixel_ok, **par)
    res = spec_obs_ok - fmod
    prms = np.nanstd(res) / np.nanmean(fmod) * 100

    rvo = 1000 * float(par.rv)       # km/s -> m/s
    e_rvo = 1000 * float(par.rv.unc if par.rv.unc is not None else 0)  # km/s -> m/s

    # IP shape
    ip_shape = IP_func(S_mod.vk, *par.ip)

    # parameter summary
    par_summary = {}
    for k, v in par.flat().items():
        key_str = str(k)
        par_summary[key_str] = {
            'value': _sanitize(float(v.value)),
            'unc': _sanitize(float(v.unc)) if v.unc is not None else None,
        }

    return {
        'converged': True,
        'rv': _sanitize(rvo),
        'e_rv': _sanitize(e_rvo),
        'prms': _sanitize(float(prms)),
        'pixel_ok': _safe_list(pixel_ok),
        'wave_ok': _safe_list(wave_obs_ok),
        'spec_ok': _safe_list(spec_obs_ok),
        'model_flux': _safe_list(fmod),
        'residuals': _safe_list(res),
        'ip_vk': _safe_list(S_mod.vk),
        'ip_shape': _safe_list(ip_shape),
        'flag': flag_obs.tolist(),
        'params': par_summary,
        'berv': setup_result['berv'],
        'dateobs': setup_result['dateobs'],
    }


def _load_atmosphere(lnwave_j, lmin, lmax, wave_obs, atmos_dir,
                     molecules=None, tellshift=False):
    '''
    Load atmosphere FITS files and extract molecular spectra for the wavelength range.
    '''
    bands_all = ['vis', 'J', 'H', 'K']
    wave_band = np.array([0, 9000, 14000, 18500])

    obs_lmin = min(wave_obs[0], wave_obs[-1])
    obs_lmax = max(wave_obs[0], wave_obs[-1])

    w0 = obs_lmin - wave_band
    w1 = obs_lmax - wave_band
    idx_start = np.argmin(w0[w0 >= 0])
    idx_end = int(np.argmin(w1[w1 >= 0]) + 1)
    bands = bands_all[idx_start:idx_end]

    if not bands:
        bands = ['K']

    from collections import defaultdict
    specs_molec_all = defaultdict(list)
    wave_atm_all = defaultdict(list)

    for band in bands:
        try:
            fpath = f'{atmos_dir}/stdAtmos_{band}.fits'
            hdu = fits.open(fpath)
            cols = hdu[1].columns.names
            data = hdu[1].data

            if molecules is None or molecules == ['all'] or 'all' in (molecules or []):
                molec_sel = [c for c in cols if c != 'lambda']
            else:
                molec_sel = molecules

            for mol in molec_sel:
                if mol != 'lambda' and mol in cols:
                    specs_molec_all[mol].extend(data[mol])
                    wave_atm_all[mol].extend(data['lambda'] * (1 + (-0.249 / 3e5)))

            hdu.close()
        except Exception as e:
            print(f'Warning: could not load atmosphere band {band}: {e}')

    molec_list = list(specs_molec_all.keys())
    specs_molec = np.zeros((0, len(lnwave_j)))
    par_atm = []

    for mol in molec_list:
        s_mol = slice(*np.searchsorted(wave_atm_all[mol], [lmin, lmax]))
        wave_mol = np.array(wave_atm_all[mol])
        spec_mol_raw = np.array(specs_molec_all[mol])

        if len(spec_mol_raw[s_mol]) > 0:
            spec_mol = np.interp(lnwave_j, np.log(wave_mol[s_mol]), spec_mol_raw[s_mol])
            specs_molec = np.r_[specs_molec, [spec_mol]]
            if np.nanstd(spec_mol) > 0.0001:
                par_atm.append((1, np.inf))
            else:
                par_atm.append((np.nan, 0))
        else:
            specs_molec = np.r_[specs_molec, [lnwave_j * 0 + 1]]
            par_atm.append((np.nan, 0))

    if tellshift and len(molec_list) > 0:
        par_atm.append((1, np.inf))

    return specs_molec, par_atm
