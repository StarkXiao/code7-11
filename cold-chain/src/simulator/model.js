// 确定性伪随机数（mulberry32）：同一剧本每次跑出完全一致的证据，便于演示与回归测试
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STEP_MS = 60 * 1000; // 每 60 秒一个读数

/**
 * 温度演化模型（简化一阶热平衡）：
 *   dT = (ambient - T) * k * dt + 制冷项 + 噪声
 * 冷机开时按 coolingCperMin 拉低；门开时引入 ambient 的强耦合；故障即冷机停机。
 * 车载冷机自带温控器：货温达到 setpoint 后停机、回升到 setpoint+hysteresis 再启动，
 * 否则恒定制冷会把温度无限打穿物理量程。
 */
export function nextTemp(prev, opts) {
  const {
    ambient, coolingOn, doorOpen, coolingRate, ambientLeak, doorLeak, noise, rand,
    setpoint = null, hysteresis = 1.2,
  } = opts;
  let compressor = coolingOn;
  if (compressor && setpoint !== null) {
    if (prev <= setpoint) compressor = false;
    if (prev >= setpoint + hysteresis) compressor = true;
  }
  const leak = doorOpen ? doorLeak : ambientLeak;
  const dT = (ambient - prev) * leak * (STEP_MS / 60000)
    + (compressor && !doorOpen ? -coolingRate * (STEP_MS / 60000) : 0)
    + (rand() - 0.5) * 2 * noise;
  return +(prev + dT).toFixed(2);
}
