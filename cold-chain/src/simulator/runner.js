// 剧本执行器：把一个剧本完整跑一遍（注册 → 发运 → 逐分钟读数 → 交接 → 签收 → 完结）
// 时间使用固定锚点，不依赖墙钟，因此同一剧本产出的证据链可逐字节复现。
import { rng, nextTemp } from './model.js';

export async function runScenario(services, compiled, options = {}) {
  const { commands, gateway } = services;
  const baseTs = options.baseTs ?? new Date('2026-09-19T01:00:00Z').getTime();
  const tsAt = (minute) => baseTs + minute * compiled.stepMs;
  const rand = rng(compiled.seed);

  // 1) 注册传感器与批次，发运
  for (const s of compiled.sensors) {
    await commands.registerSensor(s);
  }
  const batch = await commands.registerBatch({
    ...compiled.batch,
    zone: compiled.zone,
    sensorIds: compiled.sensors.map((s) => s.id),
  });
  await commands.startBatch(batch.code, tsAt(0));

  // 2) 逐分钟推进
  const signals = [];
  const temps = new Map(compiled.sensors.map((s, i) => [s.id, compiled.startTemp + (i * 0.3)]));

  for (let m = 0; m < compiled.minutes; m++) {
    // 交接（与该分钟读数同时刻，交接先于读数）
    for (const h of compiled.handoversAt(m)) {
      await commands.recordHandover({
        batchCode: batch.code,
        stage: h.stage,
        holder: h.holder,
        measuredTempC: h.measuredTempC,
        note: h.note,
        ts: tsAt(m),
      });
    }

    const world = compiled.stateAt(m);
    for (const s of compiled.sensors) {
      const prev = temps.get(s.id);
      const tempC = nextTemp(prev, {
        ambient: world.ambient,
        coolingOn: world.coolingOn,
        doorOpen: world.doorOpen,
        coolingRate: compiled.physics.coolingRate,
        ambientLeak: world.afterArrival && compiled.physics.destLeak ? compiled.physics.destLeak : compiled.physics.ambientLeak,
        doorLeak: compiled.physics.doorLeak,
        noise: compiled.physics.noise,
        setpoint: compiled.physics.setpoint ?? null,
        rand,
      });
      temps.set(s.id, tempC);
      const res = await gateway.ingest({ batchId: batch.id, sensorId: s.id, tempC, ts: tsAt(m) });
      for (const sig of res.signals) signals.push({ atMin: m, ...sig });
    }
    options.onTick?.({ minute: m, temps: new Map(temps), world });
  }

  // 3) 批次完结（开启中的超温按结束时刻收口）
  await commands.finishBatch(batch.code, tsAt(compiled.minutes));
  return { batch, baseTs, signals };
}
