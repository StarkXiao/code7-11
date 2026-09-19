// 三个剧本覆盖三种责任认定：运输冷机故障 / 发货方预冷不合格 / 收货方冷库失职
import { STEP_MS } from './model.js';

const t0 = () => Date.now();

export const SCENARIOS = [
  {
    id: 'retransit-failure',
    title: '剧本一：运输途中冷机故障（主责：承运方）',
    expectLiability: 'transport',
    zone: 'frozen',
    seed: 20260919,
    durationMin: 360,
    batch: {
      code: 'CC-2026-0919-A',
      product: '速冻虾仁',
      quantity: '1200 kg',
      vehicleId: '沪D-7782冷',
      driver: '王师傅',
      route: { from: '舟山定海冷库', to: '合肥周谷堆冷链仓', distanceKm: 580 },
      shipper: { name: '舟山远洋食品有限公司', contact: '冷库主管 陈经理' },
      carrier: { name: '迅驰冷链物流', contact: '调度 李队' },
      consignee: { name: '周谷堆农产品冷链仓', contact: '收货员 小赵' },
    },
    sensors: [
      { id: 'TH-001', label: '1号车厢中部探头', position: '车厢中部' },
      { id: 'TH-002', label: '2号车厢门口探头', position: '车厢后门' },
    ],
    ambient: { openAir: 26, preCool: -22, destCold: -20 },
    physics: { coolingRate: 0.9, ambientLeak: 0.006, doorLeak: 0.018, noise: 0.18, setpoint: -21 },
    startTemp: -20,
    handovers: [
      { atMin: 0, stage: 'departure', holder: '冷库主管 陈经理', measuredTempC: -20.4, note: '发运测温合格，铅封号 SL9021' },
      { atMin: 180, stage: 'transit', holder: '司机 王师傅', measuredTempC: -19.5, note: '长兴服务区巡检，记录仪正常' },
      { atMin: 330, stage: 'arrival', holder: '收货员 小赵', measuredTempC: -11.2, note: '到货开门测温偏高，车厢内有融水' },
      { atMin: 360, stage: 'signoff', holder: '收货员 小赵', measuredTempC: -12.0, note: '拒收温度异常批次，保留追偿权利' },
    ],
    faults: [
      // 200 分钟时冷机皮带断裂停机，340 分钟才抢修完成（超温约 135 分钟，主责运输）
      { kind: 'cooler_off', atMin: 200, endMin: 340, note: '冷机皮带断裂，途中无法就近维修' },
      // 95 分钟服务区开门理货 5 分钟：短时回升，应被 10 分钟容忍时长豁免
      { kind: 'door_open', atMin: 95, endMin: 100 },
    ],
  },
  {
    id: 'precool-failure',
    title: '剧本二：发货时即热货（主责：发货方预冷不合格）',
    expectLiability: 'storage_origin',
    zone: 'chilled',
    seed: 424242,
    durationMin: 330,
    batch: {
      code: 'CC-2026-0919-B',
      product: '冷鲜牛腩',
      quantity: '600 kg',
      vehicleId: '苏E-3309冷',
      driver: '刘师傅',
      route: { from: '郑州万邦冷链园', to: '西安欣桥市场', distanceKm: 480 },
      shipper: { name: '中原肉业', contact: '发货主管 孙经理' },
      carrier: { name: '华通冷藏运输', contact: '车队长 钱队' },
      consignee: { name: '欣桥生鲜配送中心', contact: '收货员 小周' },
    },
    sensors: [{ id: 'TH-101', label: '车厢回风探头', position: '冷机回风口' }],
    ambient: { openAir: 31, preCool: 3, destCold: 3 },
    physics: { coolingRate: 0.08, ambientLeak: 0.003, doorLeak: 0.02, noise: 0.15, setpoint: 2 },
    // 装箱时货物中心温度 12°C（未预冷透），车厢打冷能力有限，约 3 小时才压进温区
    startTemp: 12,
    handovers: [
      { atMin: 0, stage: 'departure', holder: '发货主管 孙经理', measuredTempC: 11.6, note: '催货紧急，未等中心温度达标即放行' },
      { atMin: 300, stage: 'arrival', holder: '收货员 小周', measuredTempC: 4.1, note: '到货测温合格，但包装箱仍有途中超温记录仪曲线' },
      { atMin: 320, stage: 'signoff', holder: '收货员 小周', measuredTempC: 3.8, note: '签收，附发货超温异议单' },
    ],
    faults: [],
  },
  {
    id: 'dest-failure',
    title: '剧本三：签收合格后冷库打冷不及时（主责：收货方仓储）',
    expectLiability: 'storage_dest',
    zone: 'pharma',
    seed: 7,
    durationMin: 260,
    batch: {
      code: 'CC-2026-0919-C',
      product: '重组人胰岛素注射液',
      quantity: '80 箱',
      vehicleId: '京A-5M20医',
      driver: '赵师傅',
      route: { from: '北京通州医药仓', to: '天津滨海医院药库', distanceKm: 160 },
      shipper: { name: '京通医药物流中心', contact: '质量员 吴老师' },
      carrier: { name: '康泰医药冷链', contact: '调度 郑队' },
      consignee: { name: '滨海医院中心药库', contact: '库管 小冯' },
    },
    sensors: [{ id: 'TH-201', label: '保温箱 USB 记录仪', position: '药品保温箱内' }],
    ambient: { openAir: 29, preCool: 5, destCold: 5 },
    physics: { coolingRate: 0.12, ambientLeak: 0.004, doorLeak: 0.02, destLeak: 0.03, noise: 0.1, setpoint: 4 },
    startTemp: 5,
    handovers: [
      { atMin: 0, stage: 'departure', holder: '质量员 吴老师', measuredTempC: 5.2, note: '发运合格，冷藏车预冷 30 分钟' },
      { atMin: 150, stage: 'arrival', holder: '库管 小冯', measuredTempC: 5.6, note: '到货测温合格，月台交接' },
      // 签收温度合格，但药品在收货月台滞留、冷库压缩机故障，2-8°C 要求下 30 分钟后超温
      { atMin: 165, stage: 'signoff', holder: '库管 小冯', measuredTempC: 6.1, note: '签收合格；随后冷库入库排队' },
    ],
    faults: [
      // 签收后货物在月台滞留、冷库压缩机故障，库温升至 14°C 直至 250 分钟修复
      // （温区 2-8°C、容忍 5 分钟，升温在收货段持续约 65 分钟）
      { kind: 'ambient_shift', atMin: 170, endMin: 250, ambient: 14, note: '收货冷库压缩机故障，月台滞留' },
    ],
  },
];

// 把剧本编译为逐分钟的"世界状态"序列（冷却开关/门状态/环境温度），供 runner 驱动
export function compileScenario(sc) {
  const minutes = sc.durationMin;
  const ambientAt = (m) => {
    if (m < 0) return sc.ambient.preCool;
    for (const f of sc.faults ?? []) {
      if (f.kind === 'ambient_shift' && m >= f.atMin && m < f.endMin) return f.ambient;
    }
    // arrival 后货物已到目的地（默认进入目的地冷库），剧本三的故障用 ambient_shift 覆盖
    const arrival = (sc.handovers || []).find((h) => h.stage === 'arrival');
    if (arrival && m >= arrival.atMin) return sc.ambient.destCold;
    return sc.ambient.openAir;
  };
  const doorAt = (m) =>
    (sc.faults ?? []).some((f) => f.kind === 'door_open' && m >= f.atMin && m < f.endMin);

  const handoverAt = new Map();
  for (const h of sc.handovers || []) {
    if (!handoverAt.has(h.atMin)) handoverAt.set(h.atMin, []);
    handoverAt.get(h.atMin).push(h);
  }

  return {
    ...sc,
    minutes,
    stepMs: STEP_MS,
    stateAt: (m) => {
      const arrival = (sc.handovers || []).find((h) => h.stage === 'arrival');
      const afterArrival = arrival && m >= arrival.atMin;
      // 到货后车辆冷机停止打冷；正常目的地冷库会主动把货温拉回库温
      let coolingOn;
      if (afterArrival) {
        coolingOn = true;
        for (const f of sc.faults ?? []) {
          if (f.kind === 'cooler_off' && m >= f.atMin && m < f.endMin) coolingOn = false;
        }
      } else {
        coolingOn = true;
        for (const f of sc.faults ?? []) {
          if (f.kind === 'cooler_off' && m >= f.atMin && m < f.endMin) coolingOn = false;
        }
      }
      return { ambient: ambientAt(m), coolingOn, doorOpen: doorAt(m), afterArrival: Boolean(afterArrival) };
    },
    handoversAt: (m) => handoverAt.get(m) || [],
  };
}

export function scenarioById(id) {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) throw new Error(`未知剧本: ${id}（可选：${SCENARIOS.map((s) => s.id).join(', ')}）`);
  return compileScenario(sc);
}
