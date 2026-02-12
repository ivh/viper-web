#! /usr/bin/env python3
# Licensed under a GPLv3 style license - see LICENSE

import numpy as np

from astropy.io import fits

c = 299792458   # [m/s] speed of light


def FTSfits(ftsname):

    if ftsname.endswith(".dat"):
        data = np.loadtxt(ftsname)
        w = data[:, 0]
        f = data[:, 1]
        f = f[::-1]
        w = 1e8 / w[::-1]
    elif ftsname.endswith(".fits"):
        hdu = fits.open(ftsname, ignore_blank=True, output_verify='silentfix')

        hdr = hdu[0].header
        cdelt1 = hdr.get('CDELT1', 'none')

        if cdelt1 == 'none':
            wavetype = hdr.get('wavetype', 'none')
            unit = hdr.get('unit', 'none')
            w = hdu[1].data['wave']
            f = hdu[1].data['flux']

            if wavetype == 'wavenumber':  w = 1e8 / w[::-1]
            if unit == 'nm': w *= 10

        else:
            f = hdu[0].data[::-1]
            try:
                w = hdr['CRVAL1'] + hdr['CDELT1'] * (np.arange(f.size) + 1. - hdr['CRPIX1'])
            except:
                w = hdr['CRVAL1'] + hdr['CDELT1'] * (np.arange(f.size) + 1.)
            w = 1e8 / w[::-1]   # convert wavenumbers to wavelength [angstrom]

    return w, f


def resample(w, f, dv=100):
    '''
    dv: Sampling step for uniform log(lambda) [m/s]
    '''
    u = np.log(w)
    uj = np.arange(u[0], u[-1], dv/c)
    iod_j = np.interp(uj, u, f)

    return w, f, uj, iod_j


def make_fake_cell(wave_min, wave_max, npix, dv=200):
    '''
    Create a flat unity spectrum in log-wavelength space.
    Replicates viper.py nocell mode (lines 789-794).

    Parameters
    ----------
    wave_min : float
        Minimum wavelength [Angstrom].
    wave_max : float
        Maximum wavelength [Angstrom].
    npix : int
        Number of pixels (used to set density of the wavelength grid).
    dv : float
        Sampling step for uniform log(lambda) [m/s].

    Returns
    -------
    wave_cell, spec_cell, lnwave_j, spec_cell_j
    '''
    wave_cell = np.linspace(wave_min, wave_max, npix * 200)
    spec_cell = wave_cell * 0 + 1
    u = np.log(wave_cell)
    lnwave_j = np.arange(u[0], u[-1], dv / c)
    spec_cell_j = lnwave_j * 0 + 1

    return wave_cell, spec_cell, lnwave_j, spec_cell_j
