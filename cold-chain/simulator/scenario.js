/**
 * 演示场景：一批重组人胰岛素（要求 2–8℃）从上海发往杭州。
 *
 * 承运链（同一冷藏车厢，跨三个载具/温控位）：
 *   08:00 沪A·8D23F 冷藏车发运   —— 上海浦东医药物流（干线）
 *   09:30 交接至分拨月台 D-07    —— 杭州城北分拨中心（中转装卸）
 *   10:10 浙A·5K71Q 城配面包车   —— 杭州末端配送站
 *   11:40 交付 杭州仁爱医院药房  —— 签收，运输结束
 *
 * 故意制造两类超温：
 *   A) 09:15→09:50 机组老化升温，跨过"干线→月台"交接 → 一次报警两方分责
 *   B) 10:15→10:30 频繁开门装卸小幅超温（minor）→ 末端配送站责任
 */

// 批次与温区
export const BATCH = {
  code: 'SH2026091901',
  product: '重组人胰岛素注射液（需冷藏）',
  origin: '上海浦东医药冷库',
  destination: '杭州仁爱医院药房',
  owner: '上海浦东医药物流有限公司',
  min_temp: 2,
  max_temp: 8,
};

export const COMPARTMENT = 'C1';

export const VEHICLES = [
  { code: '沪A8D23F', name: '沪A·8D23F 冷藏车', kind: 'truck' },
  { code: 'DOCK-D07', name: '城北分拨月台 D-07', kind: 'dock' },
  { code: '浙A5K71Q', name: '浙A·5K71Q 城配面包车', kind: 'van' },
  { code: 'HOSP-RCV01', name: '仁爱医院收货温控位', kind: 'dock' },
];

export const SENSORS = [
  { code: 'T-1001', vehicle_code: '沪A8D23F', compartment: COMPARTMENT },
  { code: 'T-1002', vehicle_code: 'DOCK-D07', compartment: COMPARTMENT },
  { code: 'T-1003', vehicle_code: '浙A5K71Q', compartment: COMPARTMENT },
];

/** 环节定义（startMin/endMin 为相对基准时刻 T0 的分钟偏移） */
export const SEGMENTS = [
  {
    vehicle_code: '沪A8D23F',
    stage: 'line_haul',
    stageLabel: '干线冷藏运输',
    party: '上海浦东医药物流（干线承运）',
    operator: '司机 王建国',
    startMin: 0,
    endMin: 90,
  },
  {
    vehicle_code: 'DOCK-D07',
    stage: 'transfer',
    stageLabel: '中转装卸（分拨月台）',
    party: '杭州城北分拨中心',
    operator: '仓管 李晓梅',
    startMin: 90,
    endMin: 130,
  },
  {
    vehicle_code: '浙A5K71Q',
    stage: 'last_mile',
    stageLabel: '城市配送',
    party: '杭州末端配送站',
    operator: '司机 陈浩然',
    startMin: 130,
    endMin: 220,
  },
  {
    vehicle_code: 'HOSP-RCV01',
    stage: 'delivery',
    stageLabel: '交付签收',
    party: '杭州仁爱医院（收货方）',
    operator: '药剂科 赵敏',
    startMin: 220,
    endMin: null,
  },
];

/** 业务事件（开门、设备异常等） */
export const NOTES = [
  { min: 0, kind: 'handover_note', detail: '装车完成，铅封号 SF-77821，发运' },
  { min: 70, kind: 'equipment_fault', detail: '车载冷机异响，司机调大设定温度后继续行驶' },
  { min: 90, kind: 'door_open', detail: '到达城北分拨月台，开箱卸货（月台冷幕开启）' },
  { min: 115, kind: 'door_open', detail: '月台分拣完成，待装车' },
  { min: 130, kind: 'door_open', detail: '城配装车，多次开关门理货' },
  { min: 145, kind: 'handover_note', detail: '发现温度偏高，司机关闭制冷除霜模式' },
  { min: 220, kind: 'handover_note', detail: '送达医院，扫码签收，铅封完好' },
];

/** 采样间隔 5 分钟；关键帧 [分钟, 温度°C]，采样点做线性插值 + 固定种子微噪声 */
export const SAMPLE_INTERVAL_MIN = 5;
export const NOISE_SEED = 20260919;
export const NOISE_AMP = 0.12;

/** 干线冷藏车温度曲线：09:15(min75) 起冷机异常升温，09:30 交接时 9.4，月台恢复 */
export const CURVE_TRUCK = [
  [0, 4.6], [60, 5.1], [70, 5.6], [75, 8.4], [85, 9.1], [90, 9.4],
];

/** 月台温控位曲线：到货仍 9.4，逐步回温，09:50 回到 7.8 */
export const CURVE_DOCK = [
  [90, 9.4], [100, 9.0], [110, 7.8], [115, 7.4], [130, 7.2],
];

/** 城配面包车曲线：频繁开门 10:15→10:30 小幅超温，之后稳定 */
export const CURVE_VAN = [
  [130, 7.2], [135, 8.2], [140, 8.5], [145, 8.3], [150, 7.6],
  [160, 6.8], [180, 6.2], [200, 5.8], [220, 5.6],
];

/** 各传感器需要推送的读数时间点（分钟），只推其在虚拟承运区间内的点 */
export const READING_RANGES = [
  { sensor: 'T-1001', fromMin: 0, toMin: 85 }, // 08:00–09:25，车在途
  { sensor: 'T-1002', fromMin: 90, toMin: 125 }, // 09:30–10:05，月台
  { sensor: 'T-1003', fromMin: 130, toMin: 215 }, // 10:10–11:35，城配在途（11:40 交接给医院温控位）
];
