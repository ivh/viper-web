// worker.js - Pyodide Web Worker for VIPER-Web
importScripts('https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js');

let pyodide = null;
let atmosCache = {};

function sendLog(msg) {
    postMessage({type: 'log', msg});
}

function sendStatus(msg) {
    postMessage({type: 'status', msg});
}

// --- Atmosphere loading ---

async function loadAtmosphere(band) {
    if (atmosCache[band]) {
        sendLog(`  Atmosphere ${band} already cached.`);
        return;
    }
    sendLog(`  Fetching atmosphere: stdAtmos_${band}.fits ...`);
    sendStatus(`Downloading atmosphere model (${band} band)...`);

    let cache;
    try { cache = await caches.open('viper-atmos-v1'); } catch(e) {}

    const localUrl = `atmos/stdAtmos_${band}.fits`;
    const remoteUrl = `https://raw.githubusercontent.com/mzechmeister/viper/master/lib/atmos/stdAtmos_${band}.fits`;
    let resp;

    if (cache) {
        resp = await cache.match(localUrl);
        if (resp) {
            sendLog(`  Loaded ${band} from browser cache.`);
        }
    }

    if (!resp) {
        resp = await fetch(localUrl);
        if (!resp.ok) {
            sendLog(`  Local not found, fetching from viper repo...`);
            resp = await fetch(remoteUrl);
        }
        if (!resp.ok) {
            sendLog(`  Warning: failed to fetch atmosphere ${band} (${resp.status})`);
            return;
        }
        if (cache) {
            try { await cache.put(localUrl, resp.clone()); } catch(e) {}
        }
    }

    const buf = await resp.arrayBuffer();
    pyodide.FS.writeFile(`/home/pyodide/atmos/stdAtmos_${band}.fits`, new Uint8Array(buf));
    atmosCache[band] = true;
    sendLog(`  Atmosphere ${band} loaded (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB).`);
}

function getBandsForWavelength(wmin, wmax) {
    const bands_all = ['vis', 'J', 'H', 'K'];
    const wave_band = [0, 9000, 14000, 18500];

    const w0 = wave_band.map(wb => wmin - wb);
    const w1 = wave_band.map(wb => wmax - wb);

    const posW0 = w0.map((v, i) => v >= 0 ? [v, i] : null).filter(x => x);
    const posW1 = w1.map((v, i) => v >= 0 ? [v, i] : null).filter(x => x);

    if (posW0.length === 0 || posW1.length === 0) return ['K'];

    posW0.sort((a, b) => a[0] - b[0]);
    posW1.sort((a, b) => a[0] - b[0]);

    const iStart = posW0[0][1];
    const iEnd = posW1[0][1] + 1;

    return bands_all.slice(iStart, iEnd);
}

// --- Message queue (serialize so init completes before other calls) ---

const messageQueue = [];
let processing = false;

onmessage = (e) => {
    messageQueue.push(e.data);
    if (!processing) processQueue();
};

async function processQueue() {
    processing = true;
    while (messageQueue.length > 0) {
        const {type, id, ...payload} = messageQueue.shift();
        try {
            let result;
            switch (type) {
                case 'init':
                    result = await handleInit();
                    break;
                case 'writeFile':
                    handleWriteFile(payload);
                    result = null;
                    break;
                case 'scanHeader':
                    result = handleScanHeader(payload);
                    break;
                case 'setup':
                    result = await handleSetup(payload);
                    break;
                case 'setupMulti':
                    result = await handleSetupMulti(payload);
                    break;
                case 'fit':
                    result = handleFit(payload);
                    break;
                case 'fitMulti':
                    result = handleFitMulti(payload);
                    break;
                default:
                    throw new Error(`Unknown message type: ${type}`);
            }
            postMessage({type: 'done', id, data: result});
        } catch (err) {
            postMessage({type: 'error', id, msg: err.message});
        }
    }
    processing = false;
}

async function handleInit() {
    sendStatus('Loading Pyodide...');
    sendLog('Loading Pyodide runtime...');

    pyodide = await loadPyodide();
    sendLog('Pyodide loaded.');

    sendStatus('Installing packages (numpy, scipy, astropy)...');
    sendLog('Installing numpy, scipy, astropy via micropip...');
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    await micropip.install(['numpy', 'scipy', 'astropy']);
    sendLog('Packages installed.');

    sendStatus('Loading Python modules...');
    const pyFiles = [
        'airtovac.py', 'param.py', 'wstat.py', 'fts_resample.py',
        'read_crires.py', 'model.py', 'fitting.py'
    ];

    for (const fname of pyFiles) {
        const resp = await fetch(`python/${fname}`);
        const text = await resp.text();
        pyodide.FS.writeFile(`/home/pyodide/${fname}`, text);
        sendLog(`  loaded ${fname}`);
    }

    pyodide.runPython(`
import sys
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')
`);

    try { pyodide.FS.mkdir('/home/pyodide/atmos'); } catch(e) {}

    sendStatus('Ready. Upload a FITS file to begin.');
    sendLog('Initialization complete.');
}

function handleWriteFile({path, data}) {
    pyodide.FS.writeFile(path, new Uint8Array(data));
}

function handleScanHeader({path}) {
    const jsonStr = pyodide.runPython(`
import json
from read_crires import scan_fits_header
json.dumps(scan_fits_header('${path}'))
`);
    return JSON.parse(jsonStr);
}

async function handleSetup(params) {
    const {order, telluric, molecules, tplLoaded, ipType, ipHs,
           degNorm, degWave, rvGuess, tellshift, bervVal} = params;

    if (telluric === 'add') {
        const wrangeStr = pyodide.runPython(`
import json, numpy as np
from read_crires import read_spectrum
_p, _w, _s, _e, _f, _b, _d = read_spectrum('/home/pyodide/obs.fits', ${order})
json.dumps([float(np.min(_w)), float(np.max(_w))])
`);
        const [wmin, wmax] = JSON.parse(wrangeStr);
        const bands = getBandsForWavelength(wmin, wmax);
        sendLog(`  Wavelength range: ${wmin.toFixed(0)} - ${wmax.toFixed(0)} A, bands: ${bands.join(', ')}`);
        for (const band of bands) {
            await loadAtmosphere(band);
        }
    }

    const tplArg = tplLoaded ? "'/home/pyodide/tpl.fits'" : 'None';
    const molArg = molecules.length > 0 ? `[${molecules.map(m => `'${m}'`).join(',')}]` : "['all']";
    const bervArg = bervVal ? `, berv_override=${bervVal}` : '';

    sendStatus('Building model...');
    const jsonStr = pyodide.runPython(`
import json, numpy as np
from fitting import setup_model

result = setup_model(
    '/home/pyodide/obs.fits',
    order=${order},
    tpl_path=${tplArg},
    molecules=${molArg},
    telluric='${telluric}',
    tellshift=${tellshift ? 'True' : 'False'},
    deg_norm=${degNorm},
    deg_wave=${degWave},
    ip_type='${ipType}',
    ip_hs=${ipHs},
    rv_guess=${rvGuess}${bervArg}
)

_setup_data = {}
for k, v in result.items():
    if not k.startswith('_'):
        _setup_data[k] = v

json.dumps(_setup_data)
`);
    return JSON.parse(jsonStr);
}

async function handleSetupMulti(params) {
    const {orders, telluric, molecules, tplLoaded, ipType, ipHs,
           degNorm, degWave, rvGuess, tellshift, bervVal} = params;

    if (telluric === 'add') {
        const wrangeStr = pyodide.runPython(`
import json, numpy as np
from read_crires import read_spectrum
_wmin_all, _wmax_all = [], []
for _o in ${JSON.stringify(orders)}:
    _p, _w, _s, _e, _f, _b, _d = read_spectrum('/home/pyodide/obs.fits', _o)
    _wmin_all.append(float(np.min(_w)))
    _wmax_all.append(float(np.max(_w)))
json.dumps([min(_wmin_all), max(_wmax_all)])
`);
        const [wmin, wmax] = JSON.parse(wrangeStr);
        const bands = getBandsForWavelength(wmin, wmax);
        sendLog(`  Wavelength range: ${wmin.toFixed(0)} - ${wmax.toFixed(0)} A, bands: ${bands.join(', ')}`);
        for (const band of bands) {
            await loadAtmosphere(band);
        }
    }

    const tplArg = tplLoaded ? "'/home/pyodide/tpl.fits'" : 'None';
    const molArg = molecules.length > 0 ? `[${molecules.map(m => `'${m}'`).join(',')}]` : "['all']";
    const bervArg = bervVal ? `, berv_override=${bervVal}` : '';

    sendStatus('Building multi-order model...');
    const jsonStr = pyodide.runPython(`
import json, numpy as np
from fitting import setup_multi_order

result = setup_multi_order(
    '/home/pyodide/obs.fits',
    orders=${JSON.stringify(orders)},
    tpl_path=${tplArg},
    molecules=${molArg},
    telluric='${telluric}',
    tellshift=${tellshift ? 'True' : 'False'},
    deg_norm=${degNorm},
    deg_wave=${degWave},
    ip_type='${ipType}',
    ip_hs=${ipHs},
    rv_guess=${rvGuess}${bervArg}
)

_setup_data = {
    'orders': result['orders'],
    'per_order': result['per_order'],
    'berv': result['berv'],
    'dateobs': result['dateobs'],
    'ip_vk': result['ip_vk'],
    'ip_shape': result['ip_shape'],
}
json.dumps(_setup_data)
`);
    return JSON.parse(jsonStr);
}

function handleFit(params) {
    const {ipType, rvGuess, tellshift, kapsig1, kapsig2, degNorm, degWave, wgt} = params;

    const jsonStr = pyodide.runPython(`
import json
from fitting import fit_order

fit_result = fit_order(
    result,
    kapsig=(${kapsig1}, ${kapsig2}),
    deg_norm=${degNorm},
    deg_wave=${degWave},
    ip_type='${ipType}',
    rv_guess=${rvGuess},
    tellshift=${tellshift ? 'True' : 'False'},
    wgt='${wgt}',
)

json.dumps(fit_result)
`);
    return JSON.parse(jsonStr);
}

function handleFitMulti(params) {
    const {ipType, rvGuess, tellshift, kapsig1, kapsig2, degNorm, degWave, wgt} = params;

    const jsonStr = pyodide.runPython(`
import json
from fitting import fit_multi_order

fit_result = fit_multi_order(
    result,
    kapsig=(${kapsig1}, ${kapsig2}),
    deg_norm=${degNorm},
    deg_wave=${degWave},
    ip_type='${ipType}',
    rv_guess=${rvGuess},
    tellshift=${tellshift ? 'True' : 'False'},
    wgt='${wgt}',
)

json.dumps(fit_result)
`);
    return JSON.parse(jsonStr);
}
