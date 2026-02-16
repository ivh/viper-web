// VIPER-Web: app.js
// Worker communication, file handling, Plotly rendering

let obsLoaded = false;
let tplLoaded = false;
let setupResult = null;
let lastFitData = null;
let xAxis = 'wave';
let fitMode = 'single';

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

// --- Worker communication ---

const worker = new Worker('worker.js');
let callId = 0;
const pendingCalls = {};

function workerCall(type, data = {}, transfer = []) {
    return new Promise((resolve, reject) => {
        const id = callId++;
        pendingCalls[id] = {resolve, reject};
        worker.postMessage({type, id, ...data}, transfer);
    });
}

worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'done': {
            const pending = pendingCalls[msg.id];
            if (pending) {
                delete pendingCalls[msg.id];
                pending.resolve(msg.data);
            }
            break;
        }
        case 'error': {
            const pending = pendingCalls[msg.id];
            if (pending) {
                delete pendingCalls[msg.id];
                pending.reject(new Error(msg.msg));
            }
            break;
        }
        case 'log':
            log(msg.msg);
            break;
        case 'status':
            setStatus(msg.msg);
            break;
    }
};

// --- File handling ---

document.getElementById('obs-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    log(`Observation file selected: ${file.name}`);
    const buf = await file.arrayBuffer();
    const sizeKB = (buf.byteLength / 1024).toFixed(0);
    await workerCall('writeFile', {path: '/home/pyodide/obs.fits', data: buf}, [buf]);
    obsLoaded = true;
    log(`  written to virtual FS (${sizeKB} KB)`);

    try {
        const meta = await workerCall('scanHeader', {path: '/home/pyodide/obs.fits'});
        availableOrders = meta.available_orders;
        log(`  Setting: ${meta.setting}, BERV: ${meta.berv} km/s, Date: ${meta.dateobs}`);
        log(`  Available orders: ${availableOrders.join(', ')}`);

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
    const sizeKB = (buf.byteLength / 1024).toFixed(0);
    await workerCall('writeFile', {path: '/home/pyodide/tpl.fits', data: buf}, [buf]);
    tplLoaded = true;
    log(`  written to virtual FS (${sizeKB} KB)`);
});

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
        const data = await workerCall('setup', {
            order, telluric, molecules, tplLoaded, ipType, ipHs,
            degNorm, degWave, rvGuess, tellshift, bervVal
        });
        setupResult = data;
        lastFitData = null;

        log(`  BERV: ${data.berv} km/s, Date: ${data.dateobs}`);
        log(`  Good pixels: ${data.pixel_ok.length} / ${data.pixel.length}`);

        plotSpectrum(data);
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
        const data = await workerCall('setupMulti', {
            orders, telluric, molecules, tplLoaded, ipType, ipHs,
            degNorm, degWave, rvGuess, tellshift, bervVal
        });
        data._multi = true;
        setupResult = data;
        lastFitData = null;

        const totalPix = Object.values(data.per_order).reduce((s, o) => s + o.pixel_ok.length, 0);
        log(`  BERV: ${data.berv} km/s, Date: ${data.dateobs}`);
        log(`  Total good pixels: ${totalPix} across ${orders.length} orders`);

        plotMultiSpectrum(data);
        plotIP(data);

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
        const fitData = await workerCall('fit', {
            ipType, rvGuess, tellshift, kapsig1, kapsig2, degNorm, degWave, wgt
        });

        if (!fitData.converged) {
            log(`Fit failed: ${fitData.error}`);
            setStatus('Fit did not converge.');
            document.getElementById('btn-fit').disabled = false;
            document.getElementById('btn-load').disabled = false;
            return;
        }

        lastFitData = fitData;

        const rv = fitData.rv ?? 0;
        const e_rv = fitData.e_rv ?? 0;
        const prms = fitData.prms ?? 0;

        plotSpectrum(fitData, true);
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

    const ipType = document.getElementById('ip-type').value;
    const rvGuess = parseFloat(document.getElementById('rv-guess').value);
    const tellshift = document.getElementById('tellshift').value === '1';
    const kapsig1 = parseFloat(document.getElementById('kapsig1').value);
    const kapsig2 = parseFloat(document.getElementById('kapsig2').value);
    const degNorm = parseInt(document.getElementById('deg-norm').value);
    const degWave = parseInt(document.getElementById('deg-wave').value);
    const wgt = document.getElementById('wgt').value;

    try {
        const fitData = await workerCall('fitMulti', {
            ipType, rvGuess, tellshift, kapsig1, kapsig2, degNorm, degWave, wgt
        });

        if (!fitData.converged) {
            log(`Multi-order fit failed: ${fitData.error}`);
            setStatus('Multi-order fit did not converge.');
            document.getElementById('btn-fit').disabled = false;
            document.getElementById('btn-load').disabled = false;
            return;
        }

        lastFitData = fitData;

        const rv = fitData.rv ?? 0;
        const e_rv = fitData.e_rv ?? 0;

        fitData._multi = true;
        plotMultiSpectrum(fitData, true);
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

function getXData(pixelArr, waveArr) {
    return xAxis === 'wave' ? waveArr : pixelArr;
}

function getXLabel() {
    return xAxis === 'wave' ? 'Vacuum wavelength [A]' : 'Pixel';
}

const axStyle = { gridcolor: '#0f3460', zerolinecolor: '#0f3460' };

function plotSpectrum(data, isFit = false) {
    const div = document.getElementById('plot-spectrum');
    const xOk = getXData(data.pixel_ok, data.wave_ok);

    const traces = [
        {
            x: xOk, y: data.spec_ok,
            mode: 'markers', marker: { size: 3, color: '#a0c4ff' },
            name: 'Observation',
        },
        {
            x: xOk, y: data.model_flux,
            mode: 'lines', line: { color: '#e94560', width: 1.5 },
            name: isFit ? 'Fitted model' : 'Initial model',
        },
    ];

    if (data.atm_flux && data.lnwave_j && !isFit) {
        const atmX = xAxis === 'wave' ? data.lnwave_j.map(lw => Math.exp(lw)) : null;
        if (atmX) {
            const ymax = Math.max(...data.spec_ok.filter(v => isFinite(v)));
            traces.push({
                x: atmX, y: data.atm_flux.map(v => v * ymax),
                mode: 'lines', line: { color: '#7ee787', width: 0.8 },
                name: 'Atmosphere', opacity: 0.5,
            });
        }
    }

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
                x: flagged_x, y: flagged_y,
                mode: 'markers', marker: { size: 3, color: '#555', symbol: 'x' },
                name: 'Flagged',
            });
        }
    }

    // residuals on shared x-axis, separate y-axis
    if (data.residuals && data.residuals.length > 0) {
        traces.push({
            x: xOk, y: data.residuals,
            mode: 'markers', marker: { size: 2.5, color: '#a0c4ff' },
            name: 'Residuals', xaxis: 'x', yaxis: 'y2',
        });
        traces.push({
            x: [xOk[0], xOk[xOk.length - 1]], y: [0, 0],
            mode: 'lines', line: { color: '#e94560', width: 1, dash: 'dash' },
            showlegend: false, xaxis: 'x', yaxis: 'y2',
        });
    }

    const layout = {
        ...plotLayout, height: 500,
        title: { text: 'Spectrum + Model', font: { size: 13, color: '#e94560' } },
        xaxis: { ...axStyle, title: getXLabel(), anchor: 'y2' },
        yaxis: { ...axStyle, title: 'Flux', domain: [0.28, 1] },
        yaxis2: { ...axStyle, title: 'Residual', domain: [0, 0.22] },
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

        // residuals on y2
        if (od.residuals) {
            traces.push({
                x: xOk, y: od.residuals,
                mode: 'markers', marker: { size: 2.5, color },
                showlegend: false, xaxis: 'x', yaxis: 'y2',
            });
        }
    });

    // zero line for residuals
    let xAll = [];
    orders.forEach(o => {
        const xOk = getXData(data.per_order[String(o)].pixel_ok, data.per_order[String(o)].wave_ok);
        if (xOk.length) { xAll.push(xOk[0]); xAll.push(xOk[xOk.length - 1]); }
    });
    if (xAll.length) {
        traces.push({
            x: [Math.min(...xAll), Math.max(...xAll)], y: [0, 0],
            mode: 'lines', line: { color: '#e94560', width: 1, dash: 'dash' },
            showlegend: false, xaxis: 'x', yaxis: 'y2',
        });
    }

    const layout = {
        ...plotLayout, height: 900,
        title: { text: `Spectrum + Model (${orders.length} orders)`, font: { size: 13, color: '#e94560' } },
        xaxis: { ...axStyle, title: getXLabel(), anchor: 'y2' },
        yaxis: { ...axStyle, title: 'Flux', domain: [0.28, 1] },
        yaxis2: { ...axStyle, title: 'Residual', domain: [0, 0.22] },
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
        const plotFn = setupResult._multi ? plotMultiSpectrum : plotSpectrum;
        if (lastFitData) {
            if (setupResult._multi) lastFitData._multi = true;
            plotFn(lastFitData, true);
        } else {
            plotFn(setupResult);
        }
    }
}


// --- Export ---

document.getElementById('btn-export-json').addEventListener('click', () => {
    if (!lastFitData) {
        log('No fit data to export.');
        return;
    }
    downloadBlob(JSON.stringify(lastFitData), 'viper_result.json', 'application/json');
    log('Exported JSON.');
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (!lastFitData) {
        log('No fit data to export.');
        return;
    }
    const data = lastFitData;
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

workerCall('init').then(() => {
    document.getElementById('btn-load').disabled = false;
}).catch(err => {
    setStatus('Failed to initialize Pyodide.');
    log('Initialization error: ' + err.message);
    console.error(err);
});
