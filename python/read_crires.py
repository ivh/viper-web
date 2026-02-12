#! /usr/bin/env python3
# Licensed under a GPLv3 style license - see LICENSE
# Simplified from inst/inst_CRIRES.py: astropy-only, no coordinates/SkyCoord

import numpy as np
from astropy.io import fits
from astropy.time import Time


def read_spectrum(filename, order):
    '''
    Read a CRIRES observation spectrum.

    Parameters
    ----------
    filename : str
        Path to FITS file.
    order : int
        Order number (1-28).

    Returns
    -------
    pixel, wave, spec, err, flag_pixel, berv, dateobs
    '''
    order_idx, detector = divmod(order - 1, 3)
    detector += 1

    hdu = fits.open(filename, ignore_blank=True)
    hdr = hdu[0].header

    nod_type = hdr.get('ESO PRO CATG', '')

    try:
        if str(nod_type) != 'OBS_NODDING_EXTRACT_COMB':
            raise ValueError
        dateobs = Time(hdr["ESO DRS TMID"], format='mjd').isot
    except:
        dateobs = hdr.get('DATE-OBS', '')

    berv = hdr.get('ESO QC BERV', 0.0)

    n_orders = max(
        int(c) for c in
        [col.split('_')[0] for col in hdu[detector].columns.names if col.endswith('_SPEC')]
    )
    order_drs = n_orders - order_idx

    spec = hdu[detector].data["0" + str(order_drs) + "_01_SPEC"].copy()
    err = hdu[detector].data["0" + str(order_drs) + "_01_ERR"].copy()
    wave = hdu[detector].data["0" + str(order_drs) + "_01_WL"].copy() * 10  # nm -> Angstrom

    pixel = np.arange(spec.size)
    flag_pixel = 1 * np.isnan(spec)

    hdu.close()

    return pixel, wave, spec, err, flag_pixel, berv, dateobs


def read_template(filename, order):
    '''
    Read a CRIRES template spectrum.

    Parameters
    ----------
    filename : str
        Path to FITS file (either _tpl.fits or regular observation).
    order : int
        Order number (1-28).

    Returns
    -------
    wave, spec
    '''
    order_idx, detector = divmod(order - 1, 3)
    detector += 1

    hdu = fits.open(filename, ignore_blank=True)
    hdr = hdu[0].header

    n_orders = max(
        int(c) for c in
        [col.split('_')[0] for col in hdu[detector].columns.names if col.endswith('_SPEC')]
    )
    order_drs = n_orders - order_idx

    spec = hdu[detector].data["0" + str(order_drs) + "_01_SPEC"].copy()
    wave = hdu[detector].data["0" + str(order_drs) + "_01_WL"].copy()

    # if it's a regular observation, wavelengths are in nm -> convert
    if not filename.endswith('_tpl.fits'):
        wave = wave * 10  # nm -> Angstrom

    hdu.close()

    return wave, spec


def scan_fits_header(filename):
    '''
    Scan FITS header for metadata useful for the UI.

    Returns
    -------
    dict with keys: berv, dateobs, setting, n_orders, available_orders
    '''
    hdu = fits.open(filename, ignore_blank=True)
    hdr = hdu[0].header

    setting = hdr.get('ESO INS WLEN ID', 'unknown')
    berv = hdr.get('ESO QC BERV', 0.0)

    nod_type = hdr.get('ESO PRO CATG', '')
    try:
        if str(nod_type) != 'OBS_NODDING_EXTRACT_COMB':
            raise ValueError
        dateobs = Time(hdr["ESO DRS TMID"], format='mjd').isot
    except:
        dateobs = hdr.get('DATE-OBS', '')

    available_orders = []
    for det in (1, 2, 3):
        try:
            cols = hdu[det].columns.names
            spec_cols = [col for col in cols if col.endswith('_SPEC')]
            n_orders_det = max(int(col.split('_')[0]) for col in spec_cols)
            for odrs in range(1, n_orders_det + 1):
                order = (n_orders_det - odrs) * 3 + det
                available_orders.append(order)
        except:
            pass

    hdu.close()

    return {
        'berv': berv,
        'dateobs': dateobs,
        'setting': setting,
        'available_orders': sorted(available_orders),
    }
