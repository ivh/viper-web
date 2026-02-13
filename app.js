// VIPER-Web: app.js
// Pyodide init, file handling, Plotly rendering

let pyodide = null;
let obsLoaded = false;
let tplLoaded = false;
let setupResult = null;  // Python dict proxy from setup_model
let xAxis = 'wave';      // 'pixel' or 'wave'
let fitMode = 'single';  // 'single' or 'multi'

const statusBar = document.getElementById('status-bar');
const logArea = document.getElementById('log-area');

function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logArea.textContent += `[${ts}] ${msg}\n`;
    logArea.scrollTop = logArea.scrollHeight;
}

function setStatus(msg) {
    statusBar.textContent = msg;
}

// --- Pyodide initialization ---

async function initPyodide() {
    setStatus('Loading Pyodide...');
    log('Loading Pyodide runtime...');

    pyodide = await loadPyodide();
    log('Pyodide loaded.');

    setStatus('Installing packages (numpy, scipy, astropy)...');
    log('Installing numpy, scipy, astropy via micropip...');
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    await micropip.install(['numpy', 'scipy', 'astropy']);
    log('Packages installed.');

    // fetch Python source files and write to virtual FS
    setStatus('Loading Python modules...');
    const pyFiles = [
        'airtovac.py', 'param.py', 'wstat.py', 'fts_resample.py',
        'read_crires.py', 'model.py', 'fitting.py'
    ];

    for (const fname of pyFiles) {
        const resp = await fetch(`python/${fname}`);
        const text = await resp.text();
        pyodide.FS.writeFile(`/home/pyodide/${fname}`, text);
        log(`  loaded ${fname}`);
    }

    // add /home/pyodide to sys.path
    pyodide.runPython(`
import sys
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')
`);

    // create atmos directory
    try { pyodide.FS.mkdir('/home/pyodide/atmos'); } catch(e) {}

    setStatus('Ready. Upload a FITS file to begin.');
    log('Initialization complete.');

    document.getElementById('btn-load').disabled = false;
}

// --- File handling ---

document.getElementById('obs-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    log(`Observation file selected: ${file.name}`);
    const buf = await file.arrayBuffer();
    pyodide.FS.writeFile('/home/pyodide/obs.fits', new Uint8Array(buf));
    obsLoaded = true;
    log(`  written to virtual FS (${(buf.byteLength / 1024).toFixed(0)} KB)`);

    // scan header for metadata
    try {
        const info = pyodide.runPython(`
import json
from read_crires import scan_fits_header
info = scan_fits_header('/home/pyodide/obs.fits')
json.dumps(info)
`);
        const meta = JSON.parse(info);
        availableOrders = meta.available_orders;
        log(`  Setting: ${meta.setting}, BERV: ${meta.berv} km/s, Date: ${meta.dateobs}`);
        log(`  Available orders: ${availableOrders.join(', ')}`);

        // auto-populate BERV field
        const bervInput = document.getElementById('berv');
        if (!bervInput.value) {
            bervInput.value = meta.berv.toFixed(3);
        }
    } catch(err) {
        log(`  Warning: could not scan header: ${err.message}`);
    }
});

document.getElementById('tpl-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    log(`Template file selected: ${file.name}`);
    const buf = await file.arrayBuffer();
    pyodide.FS.writeFile('/home/pyodide/tpl.fits', new Uint8Array(buf));
    tplLoaded = true;
    log(`  written to virtual FS (${(buf.byteLength / 1024).toFixed(0)} KB)`);
});


// --- Atmosphere loading ---

let atmosCache = {};

async function loadAtmosphere(band) {
    if (atmosCache[band]) {
        log(`  Atmosphere ${band} already cached.`);
        return;
    }
    log(`  Fetching atmosphere: stdAtmos_${band}.fits ...`);
    setStatus(`Downloading atmosphere model (${band} band)...`);

    // try Cache API first
    let cache;
    try { cache = await caches.open('viper-atmos-v1'); } catch(e) {}

    const localUrl = `atmos/stdAtmos_${band}.fits`;
    const remoteUrl = `https://raw.githubusercontent.com/mzechmeister/viper/master/lib/atmos/stdAtmos_${band}.fits`;
    let resp;

    if (cache) {
        resp = await cache.match(localUrl);
        if (resp) {
            log(`  Loaded ${band} from browser cache.`);
        }
    }

    if (!resp) {
        resp = await fetch(localUrl);
        if (!resp.ok) {
            log(`  Local not found, fetching from viper repo...`);
            resp = await fetch(remoteUrl);
        }
        if (!resp.ok) {
            log(`  Warning: failed to fetch atmosphere ${band} (${resp.status})`);
            return;
        }
        if (cache) {
            try { await cache.put(localUrl, resp.clone()); } catch(e) {}
        }
    }

    const buf = await resp.arrayBuffer();
    const fpath = `/home/pyodide/atmos/stdAtmos_${band}.fits`;
    pyodide.FS.writeFile(fpath, new Uint8Array(buf));
    atmosCache[band] = true;
    log(`  Atmosphere ${band} loaded (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB).`);
}

function getBandsForWavelength(wmin, wmax) {
    // Angstrom boundaries for bands
    const bands_all = ['vis', 'J', 'H', 'K'];
    const wave_band = [0, 9000, 14000, 18500];

    const w0 = wave_band.map(wb => wmin - wb);
    const w1 = wave_band.map(wb => wmax - wb);

    // find indices where w >= 0, then argmin
    const posW0 = w0.map((v, i) => v >= 0 ? [v, i] : null).filter(x => x);
    const posW1 = w1.map((v, i) => v >= 0 ? [v, i] : null).filter(x => x);

    if (posW0.length === 0 || posW1.length === 0) return ['K'];

    posW0.sort((a, b) => a[0] - b[0]);
    posW1.sort((a, b) => a[0] - b[0]);

    const iStart = posW0[0][1];
    const iEnd = posW1[0][1] + 1;

    return bands_all.slice(iStart, iEnd);
}

// --- Fit mode toggle ---

let availableOrders = [];

function toggleFitMode() {
    fitMode = document.getElementById('fit-mode').value;
    document.getElementById('order-single').style.display = fitMode === 'single' ? '' : 'none';
}

// --- Load & Plot ---

document.getElementById('btn-load').addEventListener('click', async () => {
    if (!obsLoaded) {
        log('No observation file loaded.');
        return;
    }

    if (fitMode === 'multi') {
        await loadMultiOrder();
    } else {
        await loadSingleOrder();
    }
});

async function loadSingleOrder() {
    const order = parseInt(document.getElementById('order').value);
    const telluric = document.getElementById('telluric').value;
    const ipType = document.getElementById('ip-type').value;
    const ipHs = parseInt(document.getElementById('ip-hs').value);
    const degNorm = parseInt(document.getElementById('deg-norm').value);
    const degWave = parseInt(document.getElementById('deg-wave').value);
    const rvGuess = parseFloat(document.getElementById('rv-guess').value);
    const tellshift = document.getElementById('tellshift').value === '1';
    const bervVal = document.getElementById('berv').value;

    const molCheckboxes = document.querySelectorAll('#molecules input[type="checkbox"]:checked');
    const molecules = Array.from(molCheckboxes).map(cb => cb.value);

    log(`Loading order ${order}...`);
    setStatus(`Loading order ${order}...`);

    document.getElementById('btn-load').disabled = true;
    document.getElementById('btn-fit').disabled = true;

    try {
        if (telluric === 'add') {
            const wrange = pyodide.runPython(`
import json, numpy as np
from read_crires import read_spectrum
_p, _w, _s, _e, _f, _b, _d = read_spectrum('/home/pyodide/obs.fits', ${order})
json.dumps([float(np.min(_w)), float(np.max(_w))])
`);
            const [wmin, wmax] = JSON.parse(wrange);
            const bands = getBandsForWavelength(wmin, wmax);
            log(`  Wavelength range: ${wmin.toFixed(0)} - ${wmax.toFixed(0)} A, bands: ${bands.join(', ')}`);

            for (const band of bands) {
                await loadAtmosphere(band);
            }
        }

        const tplArg = tplLoaded ? "'/home/pyodide/tpl.fits'" : 'None';
        const molArg = molecules.length > 0 ? `[${molecules.map(m => `'${m}'`).join(',')}]` : "['all']";
        const bervArg = bervVal ? `berv_override=${bervVal}` : '';

        const code = `
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
    rv_guess=${rvGuess},
    ${bervArg}
)

_setup_data = {}
_setup_internal = {}
for k, v in result.items():
    if k.startswith('_'):
        _setup_internal[k] = v
    else:
        _setup_data[k] = v

json.dumps(_setup_data)
`;
        setStatus('Building model...');
        const jsonStr = pyodide.runPython(code);
        const data = JSON.parse(jsonStr);
        setupResult = data;

        log(`  BERV: ${data.berv} km/s, Date: ${data.dateobs}`);
        log(`  Good pixels: ${data.pixel_ok.length} / ${data.pixel.length}`);

        plotSpectrum(data);
        plotResiduals(data);
        plotIP(data);
        setupAxisSync();

        setStatus(`Order ${order} loaded. Ready to fit.`);
        document.getElementById('btn-fit').disabled = false;
        document.getElementById('btn-export-png').disabled = false;

    } catch(err) {
        log(`Error: ${err.message}`);
        setStatus('Error loading data.');
        console.error(err);
    }

    document.getElementById('btn-load').disabled = false;
}

async function loadMultiOrder() {
    const orders = availableOrders.slice();
    if (orders.length === 0) {
        log('No available orders found. Upload a FITS file first.');
        return;
    }

    const telluric = document.getElementById('telluric').value;
    const ipType = document.getElementById('ip-type').value;
    const ipHs = parseInt(document.getElementById('ip-hs').value);
    const degNorm = parseInt(document.getElementById('deg-norm').value);
    const degWave = parseInt(document.getElementById('deg-wave').value);
    const rvGuess = parseFloat(document.getElementById('rv-guess').value);
    const tellshift = document.getElementById('tellshift').value === '1';
    const bervVal = document.getElementById('berv').value;

    const molCheckboxes = document.querySelectorAll('#molecules input[type="checkbox"]:checked');
    const molecules = Array.from(molCheckboxes).map(cb => cb.value);

    log(`Loading orders ${orders.join(', ')} (multi-order mode)...`);
    setStatus(`Loading ${orders.length} orders...`);

    document.getElementById('btn-load').disabled = true;
    document.getElementById('btn-fit').disabled = true;

    try {
        // load atmosphere for the full wavelength range
        if (telluric === 'add') {
            const wrange = pyodide.runPython(`
import json, numpy as np
from read_crires import read_spectrum
_wmin_all, _wmax_all = [], []
for _o in ${JSON.stringify(orders)}:
    _p, _w, _s, _e, _f, _b, _d = read_spectrum('/home/pyodide/obs.fits', _o)
    _wmin_all.append(float(np.min(_w)))
    _wmax_all.append(float(np.max(_w)))
json.dumps([min(_wmin_all), max(_wmax_all)])
`);
            const [wmin, wmax] = JSON.parse(wrange);
            const bands = getBandsForWavelength(wmin, wmax);
            log(`  Wavelength range: ${wmin.toFixed(0)} - ${wmax.toFixed(0)} A, bands: ${bands.join(', ')}`);
            for (const band of bands) {
                await loadAtmosphere(band);
            }
        }

        const tplArg = tplLoaded ? "'/home/pyodide/tpl.fits'" : 'None';
        const molArg = molecules.length > 0 ? `[${molecules.map(m => `'${m}'`).join(',')}]` : "['all']";
        const bervArg = bervVal ? `berv_override=${bervVal}` : '';

        const code = `
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
    rv_guess=${rvGuess},
    ${bervArg}
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
`;
        setStatus('Building multi-order model...');
        const jsonStr = pyodide.runPython(code);
        const data = JSON.parse(jsonStr);
        data._multi = true;
        setupResult = data;

        const totalPix = Object.values(data.per_order).reduce((s, o) => s + o.pixel_ok.length, 0);
        log(`  BERV: ${data.berv} km/s, Date: ${data.dateobs}`);
        log(`  Total good pixels: ${totalPix} across ${orders.length} orders`);

        plotMultiSpectrum(data);
        plotMultiResiduals(data);
        plotIP(data);
        setupAxisSync();

        setStatus(`${orders.length} orders loaded. Ready to fit.`);
        document.getElementById('btn-fit').disabled = false;
        document.getElementById('btn-export-png').disabled = false;

    } catch(err) {
        log(`Error: ${err.message}`);
        setStatus('Error loading data.');
        console.error(err);
    }

    document.getElementById('btn-load').disabled = false;
}


// --- Fit ---

document.getElementById('btn-fit').addEventListener('click', async () => {
    if (fitMode === 'multi' && setupResult && setupResult._multi) {
        await fitMultiOrder();
    } else {
        await fitSingleOrder();
    }
});

async function fitSingleOrder() {
    log('Starting fit...');
    setStatus('Fitting...');
    document.getElementById('btn-fit').disabled = true;
    document.getElementById('btn-load').disabled = true;

    const ipType = document.getElementById('ip-type').value;
    const rvGuess = parseFloat(document.getElementById('rv-guess').value);
    const tellshift = document.getElementById('tellshift').value === '1';
    const kapsig1 = parseFloat(document.getElementById('kapsig1').value);
    const kapsig2 = parseFloat(document.getElementById('kapsig2').value);
    const degNorm = parseInt(document.getElementById('deg-norm').value);
    const degWave = parseInt(document.getElementById('deg-wave').value);
    const wgt = document.getElementById('wgt').value;

    try {
        const code = `
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
`;
        const jsonStr = pyodide.runPython(code);
        const fitData = JSON.parse(jsonStr);

        if (!fitData.converged) {
            log(`Fit failed: ${fitData.error}`);
            setStatus('Fit did not converge.');
            document.getElementById('btn-fit').disabled = false;
            document.getElementById('btn-load').disabled = false;
            return;
        }

        const rv = fitData.rv ?? 0;
        const e_rv = fitData.e_rv ?? 0;
        const prms = fitData.prms ?? 0;

        plotSpectrum(fitData, true);
        plotResiduals(fitData, true);
        plotIP(fitData);
        displayResults(fitData);

        log(`Fit converged: RV = ${rv.toFixed(2)} +/- ${e_rv.toFixed(2)} m/s`);
        log(`  %rms = ${prms.toFixed(4)}%`);
        setStatus(`Fit complete. RV = ${rv.toFixed(2)} +/- ${e_rv.toFixed(2)} m/s`);

        document.getElementById('btn-export-json').disabled = false;
        document.getElementById('btn-export-csv').disabled = false;

    } catch(err) {
        log(`Fit error: ${err.message}`);
        setStatus('Fit error.');
        console.error(err);
    }

    document.getElementById('btn-fit').disabled = false;
    document.getElementById('btn-load').disabled = false;
}

async function fitMultiOrder() {
    const infoBox = document.getElementById('fit-info');
    infoBox.style.display = 'block';
    log('Starting multi-order fit...');
    setStatus('Fitting (multi-order)...');
    document.getElementById('btn-fit').disabled = true;
    document.getElementById('btn-load').disabled = true;
    // yield to browser so the info box renders before the blocking fit
    await new Promise(r => setTimeout(r, 50));

    const ipType = document.getElementById('ip-type').value;
    const rvGuess = parseFloat(document.getElementById('rv-guess').value);
    const tellshift = document.getElementById('tellshift').value === '1';
    const kapsig1 = parseFloat(document.getElementById('kapsig1').value);
    const kapsig2 = parseFloat(document.getElementById('kapsig2').value);
    const degNorm = parseInt(document.getElementById('deg-norm').value);
    const degWave = parseInt(document.getElementById('deg-wave').value);
    const wgt = document.getElementById('wgt').value;

    try {
        const code = `
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
`;
        const jsonStr = pyodide.runPython(code);
        const fitData = JSON.parse(jsonStr);

        if (!fitData.converged) {
            log(`Multi-order fit failed: ${fitData.error}`);
            setStatus('Multi-order fit did not converge.');
            document.getElementById('btn-fit').disabled = false;
            document.getElementById('btn-load').disabled = false;
            return;
        }

        const rv = fitData.rv ?? 0;
        const e_rv = fitData.e_rv ?? 0;

        fitData._multi = true;
        plotMultiSpectrum(fitData, true);
        plotMultiResiduals(fitData, true);
        plotIP(fitData);
        displayMultiResults(fitData);

        log(`Multi-order fit converged: RV = ${rv.toFixed(2)} +/- ${e_rv.toFixed(2)} m/s`);
        for (const o of fitData.orders) {
            const od = fitData.per_order[String(o)];
            log(`  Order ${o}: %rms = ${od.prms.toFixed(4)}%`);
        }
        setStatus(`Fit complete. RV = ${rv.toFixed(2)} +/- ${e_rv.toFixed(2)} m/s`);

        document.getElementById('btn-export-json').disabled = false;
        document.getElementById('btn-export-csv').disabled = false;

    } catch(err) {
        log(`Fit error: ${err.message}`);
        setStatus('Fit error.');
        console.error(err);
    }

    infoBox.style.display = 'none';
    document.getElementById('btn-fit').disabled = false;
    document.getElementById('btn-load').disabled = false;
}


// --- Plotting ---

const plotLayout = {
    paper_bgcolor: '#16213e',
    plot_bgcolor: '#1a1a2e',
    font: { color: '#e0e0e0', size: 11 },
    margin: { l: 60, r: 20, t: 30, b: 40 },
    xaxis: { gridcolor: '#0f3460', zerolinecolor: '#0f3460' },
    yaxis: { gridcolor: '#0f3460', zerolinecolor: '#0f3460' },
    legend: { orientation: 'h', y: 1.12 },
};

// sync x-axis zoom/pan between spectrum and residuals
let _syncingAxis = false;
function setupAxisSync() {
    const spec = document.getElementById('plot-spectrum');
    const resid = document.getElementById('plot-residuals');

    function syncFrom(source, target) {
        source.on('plotly_relayout', function(ed) {
            if (_syncingAxis) return;
            const update = {};
            if (ed['xaxis.range[0]'] !== undefined) {
                update['xaxis.range[0]'] = ed['xaxis.range[0]'];
                update['xaxis.range[1]'] = ed['xaxis.range[1]'];
            } else if (ed['xaxis.autorange']) {
                update['xaxis.autorange'] = true;
            } else {
                return;
            }
            _syncingAxis = true;
            Plotly.relayout(target, update);
            _syncingAxis = false;
        });
    }
    syncFrom(spec, resid);
    syncFrom(resid, spec);
}

function getXData(pixelArr, waveArr) {
    return xAxis === 'wave' ? waveArr : pixelArr;
}

function getXLabel() {
    return xAxis === 'wave' ? 'Vacuum wavelength [A]' : 'Pixel';
}

function plotSpectrum(data, isFit = false) {
    const div = document.getElementById('plot-spectrum');
    const xOk = getXData(data.pixel_ok, data.wave_ok);

    const traces = [
        {
            x: xOk,
            y: data.spec_ok,
            mode: 'markers',
            marker: { size: 3, color: '#a0c4ff' },
            name: 'Observation',
        },
        {
            x: xOk,
            y: data.model_flux,
            mode: 'lines',
            line: { color: '#e94560', width: 1.5 },
            name: isFit ? 'Fitted model' : 'Initial model',
        },
    ];

    // show atmosphere if available
    if (data.atm_flux && data.lnwave_j && !isFit) {
        const atmX = xAxis === 'wave'
            ? data.lnwave_j.map(lw => Math.exp(lw))
            : null;
        if (atmX) {
            // scale atmosphere to data range
            const ymax = Math.max(...data.spec_ok.filter(v => isFinite(v)));
            traces.push({
                x: atmX,
                y: data.atm_flux.map(v => v * ymax),
                mode: 'lines',
                line: { color: '#7ee787', width: 0.8 },
                name: 'Atmosphere',
                yaxis: 'y',
                opacity: 0.5,
            });
        }
    }

    // show flagged points
    if (data.flag && data.pixel) {
        const xAll = xAxis === 'wave' ? data.wave : data.pixel;
        const flagged_x = [], flagged_y = [];
        for (let i = 0; i < data.flag.length; i++) {
            if (data.flag[i] !== 0 && data.spec && isFinite(data.spec[i])) {
                flagged_x.push(xAll[i]);
                flagged_y.push(data.spec[i]);
            }
        }
        if (flagged_x.length > 0) {
            traces.push({
                x: flagged_x,
                y: flagged_y,
                mode: 'markers',
                marker: { size: 3, color: '#555', symbol: 'x' },
                name: 'Flagged',
            });
        }
    }

    const layout = {
        ...plotLayout,
        height: 350,
        title: { text: 'Spectrum + Model', font: { size: 13, color: '#e94560' } },
        xaxis: { ...plotLayout.xaxis, title: getXLabel() },
        yaxis: { ...plotLayout.yaxis, title: 'Flux' },
    };

    Plotly.react(div, traces, layout, { responsive: true });
}

function plotResiduals(data, isFit = false) {
    const div = document.getElementById('plot-residuals');

    if (!data.residuals || data.residuals.length === 0) {
        Plotly.react(div, [], { ...plotLayout, height: 180 }, { responsive: true });
        return;
    }

    const xOk = getXData(data.pixel_ok, data.wave_ok);

    const traces = [
        {
            x: xOk,
            y: data.residuals,
            mode: 'markers',
            marker: { size: 2.5, color: '#a0c4ff' },
            name: 'Residuals',
        },
        {
            x: [xOk[0], xOk[xOk.length - 1]],
            y: [0, 0],
            mode: 'lines',
            line: { color: '#e94560', width: 1, dash: 'dash' },
            showlegend: false,
        },
    ];

    const layout = {
        ...plotLayout,
        height: 180,
        title: { text: isFit ? 'Residuals (obs - model)' : 'Residuals (initial)', font: { size: 13, color: '#e94560' } },
        xaxis: { ...plotLayout.xaxis, title: getXLabel() },
        yaxis: { ...plotLayout.yaxis, title: 'Residual' },
    };

    Plotly.react(div, traces, layout, { responsive: true });
}

function plotIP(data) {
    const div = document.getElementById('plot-ip');

    if (!data.ip_vk || !data.ip_shape) {
        return;
    }

    const traces = [{
        x: data.ip_vk,
        y: data.ip_shape,
        mode: 'lines',
        line: { color: '#e94560', width: 2 },
        name: 'IP',
        fill: 'tozeroy',
        fillcolor: 'rgba(233,69,96,0.15)',
    }];

    const layout = {
        ...plotLayout,
        height: 200,
        title: { text: 'Instrumental Profile', font: { size: 13, color: '#e94560' } },
        xaxis: { ...plotLayout.xaxis, title: 'Velocity [km/s]' },
        yaxis: { ...plotLayout.yaxis, title: 'Contribution' },
    };

    Plotly.react(div, traces, layout, { responsive: true });
}


// --- Multi-order plotting ---

const orderColors = ['#a0c4ff', '#ffadad', '#bdb2ff', '#caffbf', '#ffd6a5', '#fdffb6', '#9bf6ff', '#ffc6ff'];

function plotMultiSpectrum(data, isFit = false) {
    const div = document.getElementById('plot-spectrum');
    const traces = [];
    const orders = data.orders || Object.keys(data.per_order).map(Number).sort((a,b) => a-b);

    orders.forEach((o, idx) => {
        const od = data.per_order[String(o)];
        const color = orderColors[idx % orderColors.length];
        const xOk = getXData(od.pixel_ok, od.wave_ok);

        traces.push({
            x: xOk, y: od.spec_ok,
            mode: 'markers', marker: { size: 3, color },
            showlegend: false,
        });
        traces.push({
            x: xOk, y: od.model_flux,
            mode: 'lines', line: { color: '#e94560', width: 1.5 },
            showlegend: false,
        });
    });

    const layout = {
        ...plotLayout, height: 700,
        title: { text: `Spectrum + Model (${orders.length} orders)`, font: { size: 13, color: '#e94560' } },
        xaxis: { ...plotLayout.xaxis, title: getXLabel() },
        yaxis: { ...plotLayout.yaxis, title: 'Flux' },
    };
    Plotly.react(div, traces, layout, { responsive: true });
}

function plotMultiResiduals(data, isFit = false) {
    const div = document.getElementById('plot-residuals');
    const traces = [];
    const orders = data.orders || Object.keys(data.per_order).map(Number).sort((a,b) => a-b);

    orders.forEach((o, idx) => {
        const od = data.per_order[String(o)];
        const color = orderColors[idx % orderColors.length];
        const xOk = getXData(od.pixel_ok, od.wave_ok);

        traces.push({
            x: xOk, y: od.residuals,
            mode: 'markers', marker: { size: 2.5, color },
            showlegend: false,
        });
    });

    // zero line spanning all orders
    let xAll = [];
    orders.forEach(o => {
        const od = data.per_order[String(o)];
        const xOk = getXData(od.pixel_ok, od.wave_ok);
        if (xOk.length) { xAll.push(xOk[0]); xAll.push(xOk[xOk.length - 1]); }
    });
    if (xAll.length) {
        traces.push({
            x: [Math.min(...xAll), Math.max(...xAll)], y: [0, 0],
            mode: 'lines', line: { color: '#e94560', width: 1, dash: 'dash' },
            showlegend: false,
        });
    }

    const layout = {
        ...plotLayout, height: 360,
        title: { text: isFit ? 'Residuals (obs - model)' : 'Residuals (initial)', font: { size: 13, color: '#e94560' } },
        xaxis: { ...plotLayout.xaxis, title: getXLabel() },
        yaxis: { ...plotLayout.yaxis, title: 'Residual' },
    };
    Plotly.react(div, traces, layout, { responsive: true });
}

function displayMultiResults(fitData) {
    const panel = document.getElementById('result-panel');
    panel.style.display = 'block';

    const rv = fitData.rv ?? 0;
    const e_rv = fitData.e_rv ?? 0;
    const berv = fitData.berv ?? 0;

    document.getElementById('rv-display').innerHTML =
        `RV = ${rv.toFixed(2)} <span class="unc">+/- ${e_rv.toFixed(2)} m/s</span>`;

    const orderRms = fitData.orders.map((o, i) =>
        `<span>O${o}: ${(fitData.prms_all[i] ?? 0).toFixed(3)}%</span>`
    ).join('');

    const stats = document.getElementById('stats-display');
    stats.innerHTML = [
        `<span>avg rms ${(fitData.prms ?? 0).toFixed(3)}%</span>`,
        `<span>BERV ${berv.toFixed(3)} km/s</span>`,
        `<span>${fitData.dateobs}</span>`,
        orderRms,
    ].join('');

    const grid = document.getElementById('param-grid');
    grid.innerHTML = '';
    if (fitData.params) {
        const label = (k) => k.replace(/[()' ]/g, '').replace(/,/g, '.');
        for (const [key, val] of Object.entries(fitData.params)) {
            if (val.value == null) continue;
            const unc = val.unc != null ? ` <span style="color:#556">\u00b1 ${val.unc.toPrecision(3)}</span>` : '';
            const div = document.createElement('div');
            div.className = 'pg-item';
            div.innerHTML = `<span class="pg-key">${label(key)}</span><span class="pg-val">${val.value.toPrecision(6)}${unc}</span>`;
            grid.appendChild(div);
        }
    }
}

// --- Results display ---

function displayResults(fitData) {
    const panel = document.getElementById('result-panel');
    panel.style.display = 'block';

    const rv = fitData.rv ?? 0;
    const e_rv = fitData.e_rv ?? 0;
    const prms = fitData.prms ?? 0;
    const berv = fitData.berv ?? 0;

    document.getElementById('rv-display').innerHTML =
        `RV = ${rv.toFixed(2)} <span class="unc">+/- ${e_rv.toFixed(2)} m/s</span>`;

    const stats = document.getElementById('stats-display');
    stats.innerHTML = [
        `<span>rms ${prms.toFixed(3)}%</span>`,
        `<span>BERV ${berv.toFixed(3)} km/s</span>`,
        `<span>${fitData.dateobs}</span>`,
    ].join('');

    // compact parameter grid - skip fixed/nan params
    const grid = document.getElementById('param-grid');
    grid.innerHTML = '';
    if (fitData.params) {
        // friendly names for tuple keys
        const label = (k) => k.replace(/[()' ]/g, '').replace(/,/g, '.');

        for (const [key, val] of Object.entries(fitData.params)) {
            if (val.value == null) continue;
            const unc = val.unc != null ? ` <span style="color:#556">\u00b1 ${val.unc.toPrecision(3)}</span>` : '';
            const div = document.createElement('div');
            div.className = 'pg-item';
            div.innerHTML = `<span class="pg-key">${label(key)}</span><span class="pg-val">${val.value.toPrecision(6)}${unc}</span>`;
            grid.appendChild(div);
        }
    }
}


// --- X axis toggle ---

function toggleXAxis(mode) {
    xAxis = mode;
    document.getElementById('btn-xpixel').className = mode === 'pixel' ? 'active' : '';
    document.getElementById('btn-xwave').className = mode === 'wave' ? 'active' : '';

    if (setupResult) {
        try {
            const hasFit = pyodide.runPython(`'fit_result' in dir() and fit_result.get('converged', False)`);
            if (hasFit) {
                const jsonStr = pyodide.runPython('json.dumps(fit_result)');
                const fitData = JSON.parse(jsonStr);
                if (setupResult._multi) {
                    fitData._multi = true;
                    plotMultiSpectrum(fitData, true);
                    plotMultiResiduals(fitData, true);
                } else {
                    plotSpectrum(fitData, true);
                    plotResiduals(fitData, true);
                }
            } else if (setupResult._multi) {
                plotMultiSpectrum(setupResult);
                plotMultiResiduals(setupResult);
            } else {
                plotSpectrum(setupResult);
                plotResiduals(setupResult);
            }
        } catch(e) {
            if (setupResult._multi) {
                plotMultiSpectrum(setupResult);
                plotMultiResiduals(setupResult);
            } else {
                plotSpectrum(setupResult);
                plotResiduals(setupResult);
            }
        }
    }
}


// --- Export ---

document.getElementById('btn-export-json').addEventListener('click', () => {
    try {
        const jsonStr = pyodide.runPython('json.dumps(fit_result)');
        downloadBlob(jsonStr, 'viper_result.json', 'application/json');
        log('Exported JSON.');
    } catch(e) {
        log('Export JSON failed: ' + e.message);
    }
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
    try {
        const jsonStr = pyodide.runPython('json.dumps(fit_result)');
        const data = JSON.parse(jsonStr);
        let csv = 'order,pixel,wavelength,flux,model,residual\n';
        if (data.per_order) {
            for (const o of data.orders) {
                const od = data.per_order[String(o)];
                for (let i = 0; i < od.pixel_ok.length; i++) {
                    csv += `${o},${od.pixel_ok[i]},${od.wave_ok[i]},${od.spec_ok[i]},${od.model_flux[i]},${od.residuals[i]}\n`;
                }
            }
        } else {
            for (let i = 0; i < data.pixel_ok.length; i++) {
                csv += `,${data.pixel_ok[i]},${data.wave_ok[i]},${data.spec_ok[i]},${data.model_flux[i]},${data.residuals[i]}\n`;
            }
        }
        downloadBlob(csv, 'viper_result.csv', 'text/csv');
        log('Exported CSV.');
    } catch(e) {
        log('Export CSV failed: ' + e.message);
    }
});

document.getElementById('btn-export-png').addEventListener('click', () => {
    Plotly.downloadImage('plot-spectrum', { format: 'png', width: 1200, height: 400, filename: 'viper_spectrum' });
    log('Exported PNG.');
});

function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}


// --- Startup ---

initPyodide().catch(err => {
    setStatus('Failed to initialize Pyodide.');
    log('Initialization error: ' + err.message);
    console.error(err);
});
