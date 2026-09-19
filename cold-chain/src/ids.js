/** 带前缀的短 ID，日志里一眼能看出对象类型 */

let counter = 0;

export function createId(prefix) {
  counter = (counter + 1) % 1e6;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e6).toString(36).padStart(4, '0');
  return `${prefix}_${t}${r}${counter.toString(36)}`;
}
