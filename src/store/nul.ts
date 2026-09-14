/**
 * SQLite 的 TEXT 列在第一个 NUL 处截断——不报错，安静地丢掉后面全部内容。
 *
 * 实测：一个 antigravity 会话里 `wsl -l -v` 的 UTF-16 输出被当 UTF-8 读，产生
 * 交错的 NUL；502 字符的 tool_result 存进索引再读出来只剩 342，后面 160 个
 * 字符凭空消失。round-trip 测试因此长期飘红，而失败信息指向的是内容本身，
 * 很难看出是存储层干的。
 *
 * 改存 BLOB 能保真，但 `text` / `tool_result` 上有 SQL 搜索（`LIKE` 对 BLOB
 * 不工作），所以改成**写入时转义、读取时还原**。
 *
 * 引导符用 U+FFFF：Unicode 明确规定的 noncharacter，不会出现在有效文本里；
 * 万一真出现也会被双写，所以还原无歧义。
 *
 * 两个常量用 `String.fromCharCode` 而不是字面量，免得源文件里真带上这些
 * 字符——它们在编辑器、diff、终端里都是隐形的。
 */
const NUL = String.fromCharCode(0x00);
const LEAD = String.fromCharCode(0xffff);
const ESCAPED_NUL = `${LEAD}0`;
const ESCAPED_LEAD = `${LEAD}${LEAD}`;

/**
 * 写进 SQLite 的 TEXT 列之前调用。
 *
 * 绝大多数内容两个字符都不含，直接原样返回——所以常态是零拷贝。
 */
export function encodeText(value: string): string;
export function encodeText(value: string | null | undefined): string | null;
export function encodeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.includes(NUL) && !value.includes(LEAD)) return value;
  // 顺序要紧：先把引导符自己双写，再拿它去转义 NUL。反过来会把刚写出的
  // 转义序列又转义一遍。
  return value.split(LEAD).join(ESCAPED_LEAD).split(NUL).join(ESCAPED_NUL);
}

/** 从 SQLite 的 TEXT 列读出来之后调用。 */
export function decodeText(value: string): string;
export function decodeText(value: string | null | undefined): string | null;
export function decodeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.includes(LEAD)) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== LEAD) {
      out += value[i];
      continue;
    }
    const next = value[++i];
    // 双写还原成引导符本身；LEAD+'0' 还原成 NUL；落单的引导符原样留着，
    // 宁可多留一个字符，也不要把不认识的序列吞掉。
    out += next === LEAD ? LEAD : next === '0' ? NUL : LEAD + (next ?? '');
  }
  return out;
}

/** 测试与诊断用：这段文本经过 SQLite 的 TEXT 列会不会被截断。 */
export function wouldTruncate(value: string): boolean {
  return value.includes(NUL);
}
