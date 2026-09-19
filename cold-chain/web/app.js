/* 冷链仪表盘：批次列表、实时温度曲线、超温告警、责任归因、完整溯源。零依赖原生 JS。 */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isoTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '–';
const isoHM = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

const state = {
  batches: [],
  selectedCode: null,
  report: null,
  monitor: null,
};

// ---------- API ----------
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `${res.status}`);
  }
  return res.json();
}

async function loadBatches() {
  const { items } = await api('/api/batches');
  state.batches = items;
  renderBatchList();
}

async function selectBatch(code) {
  state.selectedCode = code;
  renderBatchList();
  const [report, mon] = await Promise.all([
    api(`/api/batches/${encodeURIComponent(code)}/trace`),
    api(`/api/batches/${encodeURIComponent(code)}/monitor`),
  ]);
  state.report = report;
  state.monitor = mon;
  renderDetail();
}

// 实时模式下增量刷新当前批次（SSE 事件触发）
let refreshTimer = null;
function scheduleRefresh() {
  if (!state.selectedCode) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => selectBatch(state.selectedCode).catch(() => {}), 250);
}

// ---------- 批次列表 ----------
function renderBatchList() {
  $('#batch-count').textContent = state.batches.length;
  const list = $('#batch-list');
  if (!state.batches.length) {
    list.innerHTML = '<p class="dim" style="padding:14px">暂无批次</p>';
    return;
  }
  list.innerHTML = state.batches.map((b) => {
    const statusText = { registered: '待发运', in_transit: '运输中', completed: '已完结' }[b.status] || b.status;
    return `<div class="batch-card ${b.code === state.selectedCode ? 'active' : ''}" data-code="${esc(b.code)}">
      <div class="row1">
        <span class="code">${esc(b.code)}</span>
        ${b.openExcursions > 0 ? '<span class="tag alarm">超温告警</span>' : `<span class="tag ${b.status}">${statusText}</span>`}
      </div>
      <div class="meta">
        ${esc(b.product)} · ${esc(b.zone.name)}（${b.zone.min}~${b.zone.max}°C）<br/>
        ${esc(b.carrier || '–')} · ${esc(b.vehicleId || '无车牌')}<br/>
        读数 ${b.readingsCount} 条
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.batch-card').forEach((el) =>
    el.addEventListener('click', () => selectBatch(el.dataset.code).catch((e) => toast(e.message))));
}

// ---------- 详情渲染 ----------
function renderDetail() {
  const r = state.report;
  if (!r) return;
  const el = $('#detail');
  el.innerHTML = `
    ${headerHtml(r)}
    ${kpiHtml(r)}
    ${liveAlarmHtml()}
    ${chartCardHtml(r)}
    ${custodyHtml(r)}
    ${excursionHtml(r)}
    ${timelineHtml(r)}
    ${integrityHtml(r)}
  `;
  drawCharts(r);
}

function headerHtml(r) {
  const b = r.batch;
  return `<div class="card">
    <h3>${esc(b.code)} <span class="sub">${esc(b.product)} · ${esc(b.quantity || '')}</span></h3>
    <div class="dim" style="line-height:1.9">
      温区 <b style="color:var(--text)">${esc(b.zone.name)} ${b.zone.min}~${b.zone.max}°C</b>（容忍 ${Math.round(b.zone.toleranceMs / 60000)} 分钟）　|
      发货方：${esc(b.shipper?.name)}　|　承运方：${esc(b.carrier?.name)}（${esc(b.vehicleId || '–')}，司机 ${esc(b.driver || '–')}）　|　收货方：${esc(b.consignee?.name)}<br/>
      路线：${esc(b.route?.from)} → ${esc(b.route?.to)}${b.route?.distanceKm ? `（${b.route.distanceKm} km）` : ''}　|
      发运 ${isoTime(b.startedAt)} → 完结 ${isoTime(b.finishedAt)}
    </div>
  </div>`;
}

function kpiHtml(r) {
  const c = r.conclusion;
  const cls = c.status === 'PASS' ? 'ok' : c.status === 'REVIEW' ? 'warn' : 'bad';
  const maxDev = Math.max(0, ...r.sensors.map((s) => s.maxDeviationC));
  return `<div class="card"><div class="grid4">
    <div class="kpi"><div class="label">最终结论</div><div class="value ${cls}" style="font-size:17px">${c.status === 'PASS' ? '合格' : c.status === 'REVIEW' ? '存疑待核' : '不合格'}</div></div>
    <div class="kpi"><div class="label">超温事件</div><div class="value ${r.excursionCount ? 'bad' : 'ok'}">${r.excursionCount}</div></div>
    <div class="kpi"><div class="label">最大越限幅度</div><div class="value ${maxDev ? 'warn' : 'ok'}">${maxDev.toFixed(1)}°C</div></div>
    <div class="kpi"><div class="label">证据完整性</div><div class="value ${r.integrity.ok ? 'ok' : 'bad'}" style="font-size:16px">${r.integrity.ok ? '哈希链通过' : '被篡改'}</div></div>
  </div></div>`;
}

function liveAlarmHtml() {
  const live = state.monitor?.activeExcursions || [];
  if (!live.length) return '';
  return `<div class="card" style="border-color:var(--red)">
    <h3>🚨 实时超温告警（进行中）</h3>
    ${live.map((e) => `<div>
      传感器 <b>${esc(e.sensorId)}</b> 自 ${isoTime(new Date(e.rawStart).toISOString())} 起${e.direction === 'high' ? '超上限' : '超下限'}，
      峰值 ${e.peakTempC}°C（越限 ${Number(e.maxDeviationC).toFixed(1)}°C）
    </div>`).join('')}
  </div>`;
}

function chartCardHtml(r) {
  return `<div class="card chart-wrap">
    <h3>温度曲线 <span class="sub">绿色带为合格温区 · 红色阴影为计责超温窗口 · 紫线为交接节点</span></h3>
    <div id="charts"></div>
    <div class="legend">
      <span><i style="background:var(--green)"></i>合格温区</span>
      <span><i style="background:var(--red)"></i>超温计责窗口</span>
      <span><i style="background:var(--purple)"></i>交接时刻</span>
    </div>
  </div>`;
}

// SVG 折线图
async function drawCharts(r) {
  const wrap = $('#charts');
  if (!wrap) return;
  const data = await api(`/api/batches/${encodeURIComponent(r.batch.code)}/readings?limit=1200`);
  const bySensor = new Map();
  for (const row of data.items) {
    if (!bySensor.has(row.sensorId)) bySensor.set(row.sensorId, []);
    bySensor.get(row.sensorId).push(row);
  }
  const W = 980, H = 220, PAD_L = 46, PAD_R = 14, PAD_T = 14, PAD_B = 26;
  const allTs = data.items.map((d) => d.ts);
  const tMin = Math.min(...allTs), tMax = Math.max(...allTs);
  const excursions = r.excursions;
  const handovers = r.custody.handovers;

  wrap.innerHTML = [...bySensor.entries()].map(([sid]) => `
    <div data-chart-sensor="${esc(sid)}" style="margin:10px 0 4px;color:var(--dim);font-size:12px">${esc(sid)}</div>
    <svg data-chart="${esc(sid)}" viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px"></svg>
  `).join('');
  const svgFor = (sid) => wrap.querySelector(`svg[data-chart="${sid}"]`);

  const palette = ['#4da3ff', '#fbbf24'];
  let ci = 0;
  for (const [sid, rows] of bySensor) {
    const svg = svgFor(sid);
    const temps = rows.map((x) => x.tempC);
    // y 轴范围覆盖温区带与实际极值，留边距
    let yMin = Math.min(r.batch.zone.min, ...temps) - 2;
    let yMax = Math.max(r.batch.zone.max, ...temps) + 2;
    const x = (ts) => PAD_L + ((ts - tMin) / Math.max(1, tMax - tMin)) * (W - PAD_L - PAD_R);
    const y = (t) => PAD_T + ((yMax - t) / (yMax - tMin)) * (H - PAD_T - PAD_B);
    const ns = 'http://www.w3.org/2000/svg';
    const add = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.appendChild(node);
      return node;
    };

    // 合格温区带
    add('rect', { x: PAD_L, y: y(r.batch.zone.max), width: W - PAD_L - PAD_R, height: y(r.batch.zone.min) - y(r.batch.zone.max), class: 'band' });
    add('line', { x1: PAD_L, x2: W - PAD_R, y1: y(r.batch.zone.max), y2: y(r.batch.zone.max), class: 'band-line' });
    add('line', { x1: PAD_L, x2: W - PAD_R, y1: y(r.batch.zone.min), y2: y(r.batch.zone.min), class: 'band-line' });

    // 超温窗口（从 rawStart 到 rawEnd 底纹；计责窗口更深）
    for (const e of excursions.filter((e2) => e2.sensorId === sid)) {
      const ws = new Date(e.windowStart).getTime(), we = new Date(e.windowEnd).getTime();
      add('rect', { x: x(ws), y: PAD_T, width: Math.max(1, x(we) - x(ws)), height: H - PAD_T - PAD_B, class: 'exc' });
      add('line', { x1: x(new Date(e.rawStart).getTime()), x2: x(new Date(e.rawStart).getTime()), y1: PAD_T, y2: H - PAD_B, class: 'exc-line' });
    }

    // 交接竖线
    for (const h of handovers) {
      add('line', { x1: x(new Date(h.ts).getTime()), x2: x(new Date(h.ts).getTime()), y1: PAD_T, y2: H - PAD_B, class: 'handover' });
    }

    // 坐标轴刻度
    for (let i = 0; i <= 4; i++) {
      const tv = yMin + ((yMax - yMin) * i) / 4;
      add('text', { x: 8, y: y(tv) + 3 }).textContent = tv.toFixed(0) + '°';
    }
    for (let i = 0; i <= 5; i++) {
      const ts = tMin + ((tMax - tMin) * i) / 5;
      add('text', { x: x(ts) - 24, y: H - 8 }).textContent = isoHM(new Date(ts).toISOString());
    }

    // 温度折线
    const d = rows.map((row, i) => `${i ? 'L' : 'M'}${x(row.ts).toFixed(1)},${y(row.tempC).toFixed(1)}`).join('');
    add('path', { d, class: 'temp-line', stroke: palette[ci++ % palette.length] });
  }
}

function custodyHtml(r) {
  const stageName = { storage_origin: '发货方仓储', transport: '承运方运输', storage_dest: '收货方仓储', unattributed: '无法定位' };
  const primaryStages = new Set(r.excursions.map((e) => e.attribution.primaryStage));
  const segs = r.custody.segments;
  return `<div class="card">
    <h3>责任环节划分 <span class="sub">以交接记录实测温度为界</span></h3>
    <div class="stage-row">
      ${segs.map((s) => `<div class="stage ${primaryStages.has(s.stage) ? 'primary' : ''}">
        <div class="name">${esc(stageName[s.stage] || s.stage)}</div>
        <div class="party">${esc(s.party?.name || '责任方未登记')}${s.party?.vehicleId ? ' · ' + esc(s.party.vehicleId) : ''}</div>
        <div class="time">${isoTime(s.start)}<br/>→ ${isoTime(s.end)}（${esc(s.durationLabel)}）</div>
      </div>`).join('')}
    </div>
    <div style="margin-top:12px">
      ${handoversTable(r)}
    </div>
    ${r.custody.flags.length ? `<ul class="evidence">${r.custody.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function handoversTable(r) {
  const stageLabel = { departure: '发运交接', transit: '中转交接', arrival: '到货交接', signoff: '签收' };
  return `<table>
    <tr><th>环节</th><th>时间</th><th>责任人/岗位</th><th>实测温度</th><th>判定</th><th>备注</th></tr>
    ${r.custody.handovers.map((h) => `<tr>
      <td>${stageLabel[h.stage] || h.stage}</td>
      <td>${isoTime(h.ts)}</td>
      <td>${esc(h.holder)}</td>
      <td><b>${h.measuredTempC}°C</b></td>
      <td class="handover-verdict-${h.tempVerdict}">${h.tempVerdict === 'in' ? '合格' : h.tempVerdict === 'high' ? '超上限' : '超下限'}</td>
      <td class="dim">${esc(h.note || '')}</td>
    </tr>`).join('')}
  </table>`;
}

function excursionHtml(r) {
  if (!r.excursions.length) {
    return `<div class="card"><h3>超温事件</h3><p class="dim">无超出容忍时长的超温事件${r.excusedFluctuations.length ? `；${r.excusedFluctuations.length} 次开门/化霜类短时波动已按规则豁免` : ''}。</p></div>`;
  }
  return `<div class="card">
    <h3>超温事件与责任认定 <span class="sub">${r.severitySummary.critical} 特大 / ${r.severitySummary.major} 较大 / ${r.severitySummary.minor} 一般</span></h3>
    <table>
      <tr><th>传感器</th><th>类型</th><th>首次越限 → 恢复</th><th>峰值</th><th>计责时长</th><th>等级</th><th>责任认定</th></tr>
      ${r.excursions.map((e) => `<tr>
        <td>${esc(e.sensorLabel)}</td>
        <td>${esc(e.directionLabel)}</td>
        <td>${isoTime(e.rawStart)}<br/>→ ${isoTime(e.rawEnd)}${e.recovered ? '' : ' <span class="dim">(批次结束未恢复)</span>'}</td>
        <td>${e.peakTempC}°C<br/><span class="dim">越限 ${e.maxDeviationC}°C</span></td>
        <td><b>${esc(e.chargeableDurationLabel)}</b><br/><span class="dim">已扣容忍 ${Math.round(e.toleranceMs / 60000)} 分钟</span></td>
        <td><span class="sev-${e.severity}">${{ critical: '特大', major: '较大', minor: '一般' }[e.severity]}</span></td>
        <td>
          <b style="color:var(--red)">主责：${esc(e.attribution.primaryStageLabel)}${e.attribution.primaryParty ? ' · ' + esc(e.attribution.primaryParty.name) : ''}</b>
          <ul class="evidence">${e.attribution.evidence.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
          ${e.attribution.flags.length ? `<ul class="evidence">${e.attribution.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        </td>
      </tr>`).join('')}
    </table>
    ${liabilityHtml(r)}
  </div>`;
}

function liabilityHtml(r) {
  if (!r.liabilityDistribution.length) return '';
  return `<div style="margin-top:14px">
    <h3 style="margin-bottom:8px">责任分布（按计责时长汇总）</h3>
    ${r.liabilityDistribution.map((l) => `
      <div style="display:flex;align-items:center;gap:12px;margin:6px 0">
        <span style="width:110px">${esc(l.stageLabel)}</span>
        <div style="flex:1;background:var(--panel-2);border-radius:6px;height:18px;overflow:hidden">
          <div style="height:100%;width:${pctOf(r, l)}%;background:${l.stage === 'transport' ? '#f87171' : l.stage === 'storage_origin' ? '#fbbf24' : '#a78bfa'}"></div>
        </div>
        <span class="dim" style="width:160px">${esc(l.chargeableDurationLabel)} · ${esc(l.party?.name || '–')}</span>
      </div>`).join('')}
  </div>`;
}
function pctOf(r, l) {
  const max = Math.max(...r.liabilityDistribution.map((x) => x.chargeableMs));
  return Math.round((l.chargeableMs / max) * 100);
}

function timelineHtml(r) {
  const items = r.timeline.items.map((it) => `
    <div class="tl-item ${it.level}">
      <span class="tl-time">${isoTime(it.tsIso)}</span><b>${esc(it.title)}</b>
      <div class="dim">${esc(it.detail)}</div>
    </div>`).join('');
  return `<div class="card"><h3>关键时间线 <span class="sub">全程 ${esc(r.timeline.totalLabel)}</span></h3>
    <div class="timeline">${items || '<span class="dim">无关键事件</span>'}</div></div>`;
}

function integrityHtml(r) {
  return `<div class="card">
    <h3>证据链防篡改校验</h3>
    <p class="${r.integrity.ok ? 'integrity-ok' : 'integrity-bad'}">
      ${r.integrity.ok ? '✓ ' : '✗ '}${esc(r.integrity.message || JSON.stringify(r.integrity))}
    </p>
    <p class="dim">所有读数、交接、告警均以仅追加（append-only）方式写入事件日志，逐条 SHA-256 哈希链接；任何增删改都会在序号或哈希处断链。</p>
    ${r.conclusion.reasons.length ? `<div class="${r.conclusion.status === 'FAIL' ? 'verdict-fail' : 'verdict-review'}" style="margin-top:6px">
      结论依据：<ul class="evidence">${r.conclusion.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

// ---------- SSE ----------
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('event', (ev) => {
    try {
      const event = JSON.parse(ev.data);
      $('#seq').textContent = event.seq;
      const relevant = ['reading_ingested', 'excursion_started', 'excursion_closed', 'handover_recorded', 'batch_registered', 'batch_started', 'batch_finished', 'data_gap_detected'].includes(event.type);
      if (relevant) {
        if (event.type === 'excursion_started') toast('🚠 检测到超温事件：' + event.payload.sensorId);
        if (event.type === 'batch_registered' || event.type === 'batch_finished') loadBatches();
        scheduleRefresh();
      }
    } catch { /* ignore */ }
  });
  es.onerror = () => {
    setConn(false);
    // 浏览器会自动重连
  };
}
function setConn(on) {
  $('#conn-dot').className = `dot ${on ? 'on' : 'off'}`;
  $('#conn-text').textContent = on ? '实时已连接' : '连接断开，重连中…';
}

// ---------- 模拟控制（调用内置剧本，走网关真实写入）----------
$('#btn-sim').addEventListener('click', async () => {
  if (!confirm('将清空当前事件日志并运行三个模拟剧本（约 890 条读数），确定吗？')) return;
  const btn = $('#btn-sim');
  btn.disabled = true;
  btn.textContent = '模拟运行中…';
  try {
    // 通过受网关令牌保护的运维接口触发（演示令牌，仅开发环境）
    await api('/api/admin/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: '{}',
    });
    toast('模拟完成，已生成三个批次');
    state.selectedCode = null;
    await loadBatches();
    $('#detail').innerHTML = '<div class="empty-hint"><p>模拟数据已生成，请选择左侧批次查看。</p></div>';
  } catch (e) {
    toast('模拟失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '重置并运行模拟剧本';
  }
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- init ----------
loadBatches().then(() => {
  if (state.batches.length) selectBatch(state.batches[0].code).catch(console.error);
}).catch((e) => toast(e.message));
connectStream();
