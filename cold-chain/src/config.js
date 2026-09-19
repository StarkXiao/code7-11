/**
 * 全局配置：温区、严重程度阈值、存储路径等。
 * 阈值可按品类覆盖（批次创建时可传入 min_temp/max_temp）。
 */

/** 疫苗默认温区（摄氏度），GB/T 28842 等规范常见要求 */
export const DEFAULT_MIN_TEMP = 2;
export const DEFAULT_MAX_TEMP = 8;

/**
 * 超温严重程度判定规则（就高不就低）：
 *  - 偏离阈值上限/下限的最大幅度（°C）
 *  - 或 超温持续时长（分钟）
 * 触发任一条即达到对应级别。
 */
export const SEVERITY_RULES = {
  major: { deviation: 2.0, durationMin: 20 },
  minor: { deviation: 0.5, durationMin: 10 },
};
// 未达到 minor 两条线之一的为 trivial（瞬时波动，记录但不作为重点告警）

/** 读数采样间隔（秒）——模拟器与"读数覆盖率"统计使用 */
export const DEFAULT_SAMPLE_INTERVAL_SEC = 300;

/** 默认存储文件（事件溯源日志） */
export const DEFAULT_STORE_PATH = new URL('../../data/coldchain.jsonl', import.meta.url);

/** SSE 心跳间隔（毫秒） */
export const SSE_HEARTBEAT_MS = 25_000;
