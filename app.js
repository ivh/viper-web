// VIPER-Web: app.js
// Pyodide init, file handling, Plotly rendering

let pyodide = null;
let obsLoaded = false;
let tplLoaded = false;
let setupResult = null;  // Python dict proxy from setup_model
let xAxis = 'pixel';     // 'pixel' or 'wave'

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
        log(`  Setting: ${meta.setting}, BERV: ${meta.berv} km/s, Date: ${meta.dateobs}`);
        log(`  Available orders: ${meta.available_orders.join(', ')}`);

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

    const url = `atmos/stdAtmos_${band}.fits`;
    let resp;

    if (cache) {
        resp = await cache.match(url);
        if (resp) {
            log(`  Loaded ${band} from browser cache.`);
        }
    }

    if (!resp) {
        resp = await fetch(url);
        if (!resp.ok) {
            log(`  Warning: failed to fetch ${url} (${resp.status})`);
            return;
        }
        // cache for next time
        if (cache) {
            try { await cache.put(url, resp.clone()); } catch(e) {}
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

// --- Load & Plot ---

document.getElementById('btn-load').addEventListener('click', async () => {
    if (!obsLoaded) {
        log('No observation file loaded.');
        return;
    }

    const order = parseInt(document.getElementById('order').value);
    const telluric = document.getElementById('telluric').value;
    const ipType = document.getElementById('ip-type').value;
    const ipHs = parseInt(document.getElementById('ip-hs').value);
    const degNorm = parseInt(document.getElementById('deg-norm').value);
    const degWave = parseInt(document.getElementById('deg-wave').value);
    const rvGuess = parseFloat(document.getElementById('rv-guess').value);
    const tellshift = document.getElementById('tellshift').value === '1';
    const bervVal = document.getElementById('berv').value;

    // get selected molecules
    const molCheckboxes = document.querySelectorAll('#molecules input[type="checkbox"]:checked');
    const molecules = Array.from(molCheckboxes).map(cb => cb.value);

    log(`Loading order ${order}...`);
    setStatus(`Loading order ${order}...`);

    document.getElementById('btn-load').disabled = true;
    document.getElementById('btn-fit').disabled = true;

    // first read raw spectrum to get wavelength range for atmosphere
    try {
        if (telluric === 'add') {
            // quick read to get wavelength range
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

        // build Python call
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

# separate serializable data from Python objects
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

        setStatus(`Order ${order} loaded. Ready to fit.`);
        document.getElementById('btn-fit').disabled = false;
        document.getElementById('btn-export-png').disabled = false;

    } catch(err) {
        log(`Error: ${err.message}`);
        setStatus('Error loading data.');
        console.error(err);
    }

    document.getElementById('btn-load').disabled = false;
});


// --- Fit ---

document.getElementById('btn-fit').addEventListener('click', async () => {
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

        log(`Fit converged: RV = ${fitData.rv.toFixed(2)} +/- ${fitData.e_rv.toFixed(2)} m/s`);
        log(`  %rms = ${fitData.prms.toFixed(4)}%`);

        // display results
        displayResults(fitData);

        // update plots
        plotSpectrum(fitData, true);
        plotResiduals(fitData, true);
        plotIP(fitData);

        setStatus(`Fit complete. RV = ${fitData.rv.toFixed(2)} +/- ${fitData.e_rv.toFixed(2)} m/s`);

        document.getElementById('btn-export-json').disabled = false;
        document.getElementById('btn-export-csv').disabled = false;

    } catch(err) {
        log(`Fit error: ${err.message}`);
        setStatus('Fit error.');
        console.error(err);
    }

    document.getElementById('btn-fit').disabled = false;
    document.getElementById('btn-load').disabled = false;
});


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


// --- Results display ---

function displayResults(fitData) {
    const panel = document.getElementById('result-panel');
    panel.style.display = 'block';

    document.getElementById('rv-display').textContent =
        `RV = ${fitData.rv.toFixed(2)} m/s`;
    document.getElementById('rv-unc-display').textContent =
        `+/- ${fitData.e_rv.toFixed(2)} m/s`;
    document.getElementById('stats-display').textContent =
        `%rms = ${fitData.prms.toFixed(4)}% | BERV = ${fitData.berv.toFixed(3)} km/s | ${fitData.dateobs}`;

    // parameter table
    const tbody = document.querySelector('#param-table tbody');
    tbody.innerHTML = '';
    if (fitData.params) {
        for (const [key, val] of Object.entries(fitData.params)) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${key}</td><td>${val.value.toFixed(6)}</td><td>${val.unc !== null ? val.unc.toFixed(6) : '-'}</td>`;
            tbody.appendChild(tr);
        }
    }
}


// --- X axis toggle ---

function toggleXAxis(mode) {
    xAxis = mode;
    document.getElementById('btn-xpixel').className = mode === 'pixel' ? 'active' : '';
    document.getElementById('btn-xwave').className = mode === 'wave' ? 'active' : '';

    // re-render existing data
    if (setupResult) {
        // check if we have fit data on the python side
        try {
            const hasFit = pyodide.runPython(`'fit_result' in dir() and fit_result.get('converged', False)`);
            if (hasFit) {
                const jsonStr = pyodide.runPython('json.dumps(fit_result)');
                const fitData = JSON.parse(jsonStr);
                plotSpectrum(fitData, true);
                plotResiduals(fitData, true);
            } else {
                plotSpectrum(setupResult);
                plotResiduals(setupResult);
            }
        } catch(e) {
            plotSpectrum(setupResult);
            plotResiduals(setupResult);
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
        let csv = 'pixel,wavelength,flux,model,residual\n';
        for (let i = 0; i < data.pixel_ok.length; i++) {
            csv += `${data.pixel_ok[i]},${data.wave_ok[i]},${data.spec_ok[i]},${data.model_flux[i]},${data.residuals[i]}\n`;
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
