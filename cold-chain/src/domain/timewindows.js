// 时间轴工具：在有序读数序列上切出连续越限游程，并量化超温窗口
// 全部为纯函数，输入不可变数据，方便单测

/**
 * 按状态把相邻读数切成游程。
 * @param {Array<{ts:number,tempC:number}>} readings 已按 ts 升序
 * @param {(tempC:number)=>{status:string}} classify
 * @returns 游程序列，每条含 status/start/end 以及区间内读数；
 *          相邻同状态读数合并为一条（in / high / low）
 */
export function runsOf(readings, classify) {
  const runs = [];
  for (const r of readings) {
    const { status } = classify(r.tempC);
    const last = runs[runs.length - 1];
    if (last && last.status === status) {
      last.end = r.ts;
      last.readings.push(r);
    } else {
      runs.push({ status, start: r.ts, end: r.ts, readings: [r] });
    }
  }
  return runs;
}

/**
 * 用线性插值求温度曲线在某时刻的值（读数为点样本，区间端点需要插值）。
 * 越限游程的"真实起点"位于最后一个带内读数与第一个越限读数之间。
 */
export function interpolate(readings, ts) {
  if (readings.length === 0) return null;
  if (ts <= readings[0].ts) return readings[0].tempC;
  if (ts >= readings[readings.length - 1].ts) return readings[readings.length - 1].tempC;
  for (let i = 0; i < readings.length - 1; i++) {
    const a = readings[i];
    const b = readings[i + 1];
    if (ts >= a.ts && ts <= b.ts) {
      const ratio = b.ts === a.ts ? 0 : (ts - a.ts) / (b.ts - a.ts);
      return a.tempC + (b.tempC - a.tempC) * ratio;
    }
  }
  return null;
}

/**
 * 计算一次超温事件在容忍时长豁免后的"计责窗口"落在哪些责任段内，
 * 以及各段承担的超温时长。仅做时间切分，不含责任方解释（见 responsibility.js）。
 *
 * @param window {{start:number,end:number}} 已扣减容忍时长的超温窗口
 * @param segments {Array<{start:number,end:number,...}>} 责任段（时间上互不重叠、升序）
 */
export function splitWindowBySegments(window, segments) {
  const pieces = [];
  for (const seg of segments) {
    const s = Math.max(window.start, seg.start);
    const e = Math.min(window.end, seg.end ?? Infinity);
    if (e > s) pieces.push({ segment: seg, start: s, end: e, durationMs: e - s });
  }
  return pieces;
}

export function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}
