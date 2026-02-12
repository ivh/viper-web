# Licensed under a GPLv3 style license - see LICENSE
# from https://github.com/mzechmeister/python

from __future__ import print_function
import sys

import numpy as np

einsum_bug = tuple(map(int, np.__version__.split(".")[:2])) < (1, 7)

def wmom(y, w=None, moment=1, axis=None, e=None, dim=(), keepdims=False):
   y = np.array(y, dtype=float)

   d = range(y.ndim)
   if axis is not None:
      if isinstance(axis, int): axis = (axis,)
      axis = [d[a] for a in axis]
      dim = set(d) - set(axis)
   else:
      if isinstance(dim, int): dim = (dim,)
      dim = [d[a] for a in dim]

   if w is None:
      w = np.ones_like(y) if e is None else 1./e**2

   scalar = isinstance(moment, int)
   if scalar: moment = [moment]
   if einsum_bug and dim:
      m = [np.einsum(w, d, y**i, d, dim) for i in moment]
   else:
      m = [np.einsum(w, d, *(y,d)*i+(dim,)) for i in moment]

   if keepdims:
      kdim = [(ni if i in dim else 1) for i,ni in enumerate(y.shape)]
      m = [x.reshape(kdim) for x in m]

   return m[0] if scalar else m

def wmean(y, w=None, axis=None, dim=None):
   if w is None and dim is None:
      return np.mean(y, axis=axis)

   if dim is None and axis is None:
      wysum = np.dot(w.ravel(), y.ravel())
      wsum = float(w.sum())
   else:
      d = range(y.ndim)
      if axis is not None:
         if isinstance(axis, int): axis = (axis,)
         axis = [d[a] for a in axis]
         dim = set(d) - set(axis)
      else:
         if isinstance(dim, int): dim = (dim,)
         dim = [d[a] for a in dim]

      if w is None:
         wysum = np.einsum(y, d, dim)
         wsum = float(y.size / wysum.size)
      else:
         wysum = np.einsum(w, d, y, d, dim)
         wsum = np.einsum(w, d, dim).astype(float)

   return wysum / wsum

def wsem(y, mean=None, rescale=True, ddof=1, keepdims=False, **kwargs):
   kwargs['keepdims'] = keepdims or kwargs.get('dim') or kwargs.get('axis')

   wsum, wy = wmom(y, moment=(0,1), **kwargs)
   mean = wy / wsum
   var_mean = 1. / wsum

   if rescale:
      dof = float(y.size / mean.size)
      if dof > 1:
         if ddof: dof -= ddof
         var_mean = var_mean * wmom(y-mean, moment=2, **kwargs) / dof

   if kwargs['keepdims'] and not keepdims:
      mean = mean.squeeze()
      var_mean = var_mean.squeeze()

   return mean, np.sqrt(var_mean)


def wrms(y, w=None):
   W, quadsum = (len(y), np.dot(y,y)) if w is None else (
                 np.sum(w), np.einsum('i,i,i', w,y,y))
   return np.sqrt(quadsum/W)

quadmean = rms = wrms

def wstd(y, e, axis=None, dim=(), ret_err=False):
   w = np.zeros_like(e, dtype=float)
   with np.errstate(invalid='ignore'):
       ind = e > 0
   w[ind] = 1. / e[ind]**2

   d = range(y.ndim)
   if axis is not None:
      if isinstance(axis, int): axis = (axis,)
      axis = [d[a] for a in axis]
      dim = [i for i in d if i not in axis]

   if isinstance(dim, int): dim = (dim,)
   s = None
   if dim:
      dim = [d[a] for a in dim]
      s = tuple(slice(None) if (a in dim) else None for a in d)

   with np.errstate(divide='ignore'):
      nsum = np.einsum(ind.astype(float), d, dim)
      wsum = np.einsum(w, d, dim).astype(float)
      wmean =  np.einsum(w, d, y, d, dim) / wsum
      res = y - (wmean[s] if s else wmean)
      wstd1 = (np.einsum(w, d, res*res, d, dim) / wsum)**.5
      out = (wstd1, wmean)

   if ret_err:
      out += ((nsum/wsum)**.5,)

   return out

def wstd_new(y, mean=None, ddof=1, keepdims=False, **kwargs):
   kwargs['keepdims'] = keepdims or kwargs.get('dim') or kwargs.get('axis')

   wsum, wy = wmom(y, moment=(0,1), **kwargs)
   mean = wy / wsum
   var_mean = 1. / wsum

   dof = wmom(y, moment=0, **kwargs)
   if dof > 1:
      var_mean = var_mean * wmom(y-mean, moment=2, **kwargs) * dof / (dof-ddof)

   if kwargs['keepdims'] and not keepdims:
      mean = mean.squeeze()
      var_mean = var_mean.squeeze()

   return np.sqrt(var_mean)


def wnan_to_num(y, w=None, e=None):
   if w is None:
      if e is not None:
         w = np.zeros(y.shape)
         ind = e > 0
         w[ind] = 1. / e[ind]**2
   else:
      w = np.nan_to_num(w)

   w = np.isfinite(y) * (1. if w is None else w)
   y = np.nan_to_num(y)
   return y, w

def nanwsem(y, w=None, e=None, **kwargs):
   y, w = wnan_to_num(y, w=w, e=e)
   return wsem(y, w=w, **kwargs)

def nanwstd(y, w=None, e=None, **kwargs):
   y, w = wnan_to_num(y, w=w, e=e)
   return wstd_new(y, w=w, **kwargs)

def naniqr(x, w=None, e=None, **kwargs):
   x, w = wnan_to_num(x, w=w, e=e)
   return iqr(x, w=w, **kwargs)

def quantile(x, p, w=None, middle=False):
   ii = np.argsort(x)

   if w is None:
      i = np.multiply(p, len(x)).astype(int)
   else:
      cdf = np.cumsum(w[ii])
      cdf = cdf / float(cdf[-1])
      i = np.searchsorted(cdf, p, side='right')
   scalar = np.isscalar(i)
   if scalar: i = [i]

   quantile = x[ii.take(i, mode='clip')]

   if scalar:
      quantile = quantile[0]
   return quantile

def iqr(x, w=None, sigma=False):
   q = quantile(x, [0.25,0.75], w=w)
   iqr = q[1] - q[0]
   if sigma:
      iqr /= 1.349
   return iqr

def mad(data, axis=None, sigma=False):
   mad = np.median(np.absolute(data - np.median(data, axis)), axis)
   if sigma:
      mad *= 1.4826
   return mad

def mlrms(y, e, s=0., verbose=False, ml=True, ret_mean=False):
   n = y.size
   i = 0
   eps = .000001
   while True:
      i += 1
      w = 1 / (e**2+s**2)
      W = w.sum()
      q = 1 / np.sqrt(w.mean())
      Y = np.dot(w, y) / W
      r = y - Y

      chi2 = np.sum(w*r**2)
      wrms = np.sqrt(chi2 / W)
      if ml:
         wwrr = np.sum(w*w*r**2)
         s = np.sqrt((np.sum(w*w*(r**2-e**2)) / np.sum(w*w)).clip(min=0))
         rr = wwrr / W
      else:
         s = np.sqrt((s**2+wrms**2-q**2).clip(min=0))
         rr = wrms / q
      lnL = -0.5 * np.sum(np.log(2*np.pi/w)) - 0.5 * chi2

      if verbose: print('mean %.5g' %Y,' err', q, ' mlrms', wrms, lnL, ' rchi', chi2/n, rr, ' jit', s, s/wrms, wwrr,W)
      if -eps<rr-1<eps or s==0 or i>20:
         if ret_mean:
            return wrms, s, Y
         return wrms, s
