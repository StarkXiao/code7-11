/**
 * 把 traceShipment() 的结构化结果渲染成中文终端报告。
 * 中文按 2 个显示宽度对齐。
 */

import { fmt, fmtMin } from '../src/time.js';

function width(str) {
  let w = 0;
  for (const ch of str) w += /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

function pad(str, n, align = 'left') {
  const s = String(str);
  const gap = Math.max(0, n - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

const STAGE_LABELS = {
  line_haul: '干线冷藏运输',
  transfer: '中转装卸',
  last_mile: '城市配送',
  delivery: '交付签收',
};

const SEVERITY_LABELS = { trivial: '轻微波动', minor: '一般超温', major: '严重超温' };

function fmtDur(sec) {
  if (!sec) return '0分钟';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分钟`;
  return `${Math.floor(min / 60)}小时${min % 60}分钟`;
}

export function renderReport(trace) {
  const { shipment: s, segments, alarms, stats, verdict } = trace;
  const lines = [];
  const hr = '─'.repeat(72);

  lines.push('');
  lines.push('━'.repeat(72));
  lines.push(`  冷链运输温控追溯报告`);
  lines.push('━'.repeat(72));
  lines.push(`批次号：${s.code}`);
  lines.push(`货　品：${s.product}`);
  lines.push(`起　讫：${s.origin}  →  ${s.destination}`);
  lines.push(`货　主：${s.owner}`);
  lines.push(`温　区：${s.min_temp}°C ~ ${s.max_temp}°C`);
  lines.push(hr);

  // 承运环节链
  lines.push('一、承运环节链（责任主体）');
  for (const seg of segments) {
    const label = STAGE_LABELS[seg.stage] ?? seg.stage;
    const range = `${fmtMin(seg.started_at)} → ${seg.ended_at ? fmtMin(seg.ended_at) : '（进行中）'}`;
    lines.push(`  · ${pad(label, 9)} ${range}  ｜ ${seg.party}（${seg.operator || '—'}）`);
    if (seg.reading_count) {
      lines.push(`      本环节读数 ${seg.reading_count} 条，观测温度 ${fmtT(seg.min_temp_observed)} ~ ${fmtT(seg.max_temp_observed)}°C`);
    }
  }
  lines.push('');

  // 报警与责任拆分
  lines.push('二、超温报警与责任环节认定');
  if (!alarms.length) {
    lines.push('  无超温报警。');
  }
  alarms.forEach((a, i) => {
    const dir = a.direction === 'high' ? '超过上限' : '低于下限';
    lines.push(`  报警 ${i + 1}（${a.id}）`);
    lines.push(`    类型/级别：${dir} / ${SEVERITY_LABELS[a.severity] ?? a.severity}`);
    lines.push(`    时　　段：${fmt(a.opened_at)} → ${a.closed_at ? fmt(a.closed_at) : '未闭环'}` +
      `（持续 ${fmtDur(a.duration_sec)}）`);
    lines.push(`    峰值温度：${fmtT(a.peak_temp)}°C（${fmt(a.peak_at)}），越限读数 ${a.reading_count ?? a.readings?.length ?? 0} 条`);
    lines.push(`    责任拆分（按各承运方虚拟承运区间内的超温时长）：`);
    const split = a.responsibility?.bySegment ?? [];
    for (const b of split) {
      const label = STAGE_LABELS[b.stage] ?? b.stage;
      const pct = a.responsibility.totalSec
        ? Math.round((b.seconds / a.responsibility.totalSec) * 100)
        : 0;
      lines.push(`      - ${pad(label, 9)} ${pad(b.party, 26)} ${pad(fmtDur(b.seconds), 9)} ${pad(pct + '%', 5, 'right')}  峰值 ${fmtT(b.peak_temp)}°C`);
    }
    lines.push(`    状　　态：${a.status === 'closed' ? '已闭环（温度回到区间）' : '★ 未闭环'}`);
  });
  lines.push('');

  // 温度统计
  lines.push('三、温度数据总览');
  lines.push(`  入库读数：${stats.reading_count} 条（${stats.first_ts ? fmtMin(stats.first_ts) : '—'} ~ ${stats.last_ts ? fmtMin(stats.last_ts) : '—'}）`);
  lines.push(`  全程极值：最低 ${fmtT(stats.min_temp)}°C / 最高 ${fmtT(stats.max_temp)}°C`);
  lines.push(`  越限读数：${stats.excursion_count} 条；无承运环节的孤儿读数：${stats.orphan_count} 条`);
  lines.push('');

  // 时间线（仅打印关键节点，避免过长）
  lines.push('四、关键时间线');
  for (const item of trace.timeline) {
    if (item.kind === 'alarm_open' || item.kind === 'alarm_close' ||
        (item.kind === 'event' && !item.summary.startsWith('note'))) {
      const mark = item.kind === 'alarm_open' ? '▲' : item.kind === 'alarm_close' ? '▽' : '·';
      lines.push(`  ${mark} ${fmtMin(item.ts)}  ${item.summary}`);
    }
  }
  lines.push('');

  // 结论
  lines.push(hr);
  lines.push(`  追溯结论：${verdict.compliant ? '✓ ' : '✗ '}${verdict.label}`);
  lines.push(hr);
  lines.push('');
  return lines.join('\n');
}

function fmtT(v) {
  return v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toFixed(1);
}
