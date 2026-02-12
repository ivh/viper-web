#! /usr/bin/env python3
# Licensed under a GPLv3 style license - see LICENSE
# Adapted from utils/model.py: removed gplot/show, kept all math

import numpy as np
from scipy.optimize import curve_fit
from scipy.special import erf

c = 299792.458   # [km/s] speed of light

# IP sampling in velocity space
# index k for IP space
def IP(vk, s=2.2):
    """Gaussian IP"""
    IP_k = np.exp(-(vk/s)**2/2)
    IP_k /= IP_k.sum()
    return IP_k

def IP_sg(vk, s=2.2, e=2.):
    """super Gaussian"""
    IP_k = np.exp(-abs(vk/s)**e)
    IP_k /= IP_k.sum()
    return IP_k

def IP_ag(vk, s=2.2, a=0):
    '''Asymmetric (skewed) Gaussian.'''
    b = a / np.sqrt(1+a**2) * np.sqrt(2/np.pi)
    ss = s / np.sqrt(1-b**2)
    vk = (vk + ss*b) / ss
    IP_k = np.exp(-vk**2/2) * (1+erf(a/np.sqrt(2)*vk))
    IP_k /= IP_k.sum()
    return IP_k

def IP_agr(vk, s, a=0):
    a = 10 * np.tanh(a/10)
    return IP_ag(vk, s, a=a)

def IP_asg(vk, s=2.2, e=2., a=1):
    """asymmetric super Gaussian"""
    mu = 0
    for _ in range(2):
        IP_k = np.exp(-abs((vk+mu)/s)**e)
        IP_k *= (1+erf(a/np.sqrt(2) * (vk+mu)))
        IP_k /= IP_k.sum()
        mu += IP_k.dot(vk)
    return IP_k

def IP_sbg(vk, s1=2.2, s2=1, e=2.):
    """super bi-Gaussian"""
    IP_k = np.exp(-abs((vk)/s1)**e)
    IP_k *= (1+erf(0/np.sqrt(2) * vk))
    IP_k /= IP_k.sum()
    return IP_k

def IP_bg(vk, s1=2., s2=2.):
    """BiGaussian"""
    xc = np.sqrt(2/np.pi) * (-s1**2 + s2**2) / (s1+s2)
    vck = vk + xc
    IP_k = np.exp(-0.5*(vck/np.where(vck<0, s1, s2))**2)
    IP_k /= IP_k.sum()
    return IP_k

def IP_mcg(vk, s0=2, a1=0.1):
    """IP for multiple, central Gaussians."""
    s1 = 4 * s0
    a1 = a1 / 10
    IP_k = np.exp(-(vk/s0)**2)
    IP_k += a1 * np.exp(-(vk/s1)**2)
    IP_k = IP_k.clip(0, None)
    IP_k /= IP_k.sum()
    return IP_k

def IP_mg(vk, *a):
    """IP for multiple uniformly spaced Gaussians ('Gaussian spline')."""
    s = 0.9
    dx = s
    na = len(a) + 1
    mid = len(a) // 2
    a = np.tanh(a)
    a = [*a[:mid], 1, *a[mid:]]
    xl = np.arange(na)
    xm = np.dot(xl, a) / sum(a)

    xc = (dx * (xl-xm))[:, np.newaxis]
    IP_k = np.exp(-((vk-xc)/s)**2)
    IP_k = np.dot(a, IP_k)
    IP_k /= IP_k.sum()
    return IP_k

def IP_lor(vk, s=2.2):
    """Lorentzian IP"""
    IP_k = 1 / np.pi* np.abs(s) / (s**2+vk**2)
    IP_k /= IP_k.sum()
    return IP_k

IPs = {'g': IP, 'sg': IP_sg, 'sbg': IP_sbg, 'ag': IP_ag, 'agr': IP_agr, 'asg': IP_asg, 'bg': IP_bg, 'mg': IP_mg, 'mcg': IP_mcg, 'lor': IP_lor}


def poly(x, a):
    return np.polyval(a[::-1], x)

def pade(x, a, b):
    '''
    rational polynomial
    b: denominator coefficients b1, b2, ... (b0 is fixed to 1)
    '''
    y = poly(x, a) / (1+x*poly(x, b))
    return y


class model:
    '''
    The forward model.
    '''
    def __init__(self, *args, func_norm=poly, IP_hs=50, xcen=0):
        self.xcen = xcen
        self.S_star, self.lnwave_j, self.spec_cell_j, self.fluxes_molec, self.IP = args
        self.dx = self.lnwave_j[1] - self.lnwave_j[0]
        self.IP_hs = IP_hs
        self.vk = np.arange(-IP_hs, IP_hs+1) * self.dx * c
        self.lnwave_j_eff = self.lnwave_j[IP_hs:-IP_hs]
        self.func_norm = func_norm

    def __call__(self, pixel, rv=0, norm=[1], wave=[], ip=[], atm=[], bkg=[0], ipB=[]):
        coeff_norm, coeff_wave, coeff_ip, coeff_atm, coeff_bkg, coeff_ipB = norm, wave, ip, atm, bkg, ipB

        spec_gas = 1 * self.spec_cell_j

        if len(self.fluxes_molec):
            flux_atm = np.nanprod(np.power(self.fluxes_molec, np.abs(coeff_atm[:len(self.fluxes_molec)])[:, np.newaxis]), axis=0)

            if len(coeff_atm) == len(self.fluxes_molec)+1:
                flux_atm = np.interp(self.lnwave_j, self.lnwave_j-np.log(1+coeff_atm[-1]/c), flux_atm)

            spec_gas *= flux_atm

        Sj_eff = np.convolve(self.IP(self.vk, *coeff_ip), self.S_star(self.lnwave_j-rv/c) * (spec_gas + coeff_bkg[0]), mode='valid')

        if len(coeff_ipB):
            coeff_ipB = [coeff_ipB[0]*coeff_ip[0], *coeff_ip[1:]]
            Sj_B = np.convolve(self.IP(self.vk, *coeff_ipB), self.S_star(self.lnwave_j-rv/c) * (spec_gas + coeff_bkg[0]), mode='valid')
            Sj_A = Sj_eff
            g = self.lnwave_j_eff - self.lnwave_j_eff[0]
            g /= g[-1]
            Sj_eff = (1-g)*Sj_A + g*Sj_B

        lnwave_obs = np.log(poly(pixel-self.xcen, coeff_wave))

        Si_eff = np.interp(lnwave_obs, self.lnwave_j_eff, Sj_eff)

        Si_mod = self.func_norm(pixel-self.xcen, coeff_norm) * Si_eff
        return Si_mod

    def fit(self, pixel, spec_obs, par, sig=[], **kwargs):
        '''
        Generic fit wrapper.
        '''
        varykeys, varyvals = zip(*par.vary().items())

        S_model = lambda x, *params: self(x, **(par + dict(zip(varykeys, params))))

        params, e_params = curve_fit(S_model, pixel, spec_obs, p0=varyvals, sigma=sig, absolute_sigma=False, epsfcn=1e-12)

        pnew = par + dict(zip(varykeys, params))
        for k, v in zip(varykeys, np.sqrt(np.diag(e_params))):
            pnew[k].unc = v

        return pnew, e_params
