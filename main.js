/*
 * ============================================================
 * 健康记录插件 (Health Record Plugin)
 * ============================================================
 *
 * 插件功能：侧边栏一键记录睡眠与自定义习惯，做今日与周/月复盘；数据写在库内的 Markdown 里
 * 版本：以 manifest.json 为准（文件头不再写死，免得每次发版都落后一截）
 * 作者：duany
 * 许可证：MIT（见仓库 LICENSE）
 *
 * 源码说明：本文件即唯一源码，直接手工维护，没有构建步骤；
 * 文件内的 CommonJS 模块兼容层（__defProp / __export 等）仅供 Obsidian 加载使用，请勿删除。
 *
 * 设计取向：
 *   - 只记录、只复盘，不做提醒（Obsidian 本身不具备通知能力，做了也是自欺）
 *   - 数据存在仓库内的 Markdown 文件，不写 data.json：双端各自记时整文件覆盖会丢数据，
 *     而 md 行级追加冲突面最小，且手机上也看得见、改得动
 *   - 记录存"事件流水"而不是"当日汇总"：从时刻能推出次数与间隔，反推不回来
 *   - 类型可自建（睡眠除外）：注册表 = 内置 + settings.types，注册表外的行一律当用户内容
 *
 * 数据格式（默认目录「健康记录」，按月 2026-10月健康记录.md / 按年 2026年健康记录.md）：
 *   # 健康记录
 *
 *   ## 2026-10-18
 *
 *   - 睡眠 | 23:40 | 07:10
 *   - 早餐 | 08:05
 *   - 水 | 08:20
 *   - 水 | 09:30
 *   - 如厕 | 09:35
 *   - 午餐 | 12:30 | 食堂
 *
 *   睡眠锚定"入睡那晚"的日期：10-18 这行的 07:10 属于 10-19 清晨；
 *   起床尚未记录时写作 `- 睡眠 | 23:40 |`（第三列留空）。
 *   第三列对餐食/饮水是备注，对睡眠是起床时刻；四列及以上的行不解析、原样保留。
 *
 * 代码架构：
 *   1. 时间工具          - 本地日期串、时刻解析、睡眠时长跨午夜计算
 *   2. 记录模型与解析    - 行 <-> 记录对象的双向转换，未知行保护
 *   3. RecordManager     - 记录文件的定位/建目录/原子改写/串行写队列（按月或按年归档）
 *   4. HealthRecordView  - 侧边栏视图：今日 / 近 7 天 / 近 30 天（或本周/本月）
 *   5. RecordEditModal   - 补记与修改弹窗（用框架 Modal，保证移动端返回键可关）
 *   6. HealthRecordSettingTab
 *   7. HealthRecordPlugin
 *
 * ============================================================
 */

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ---- 模块导出：Obsidian 通过 module.exports.default 获取插件主类 ----
var main_exports = {};
__export(main_exports, {
  default: () => HealthRecordPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// ==================== 常量 ====================

var LOG = "健康记录：";
var VIEW_TYPE_HEALTH = "health-record-view";

/** 睡眠条时间轴的起点固定为 18:00：夜晚在视觉上连续，跨午夜不拆成两段 */
var NIGHT_ORIGIN = 18 * 60;

var T_SLEEP = "睡眠";
var T_WATER = "水";
var T_TOILET = "如厕";
var T_BREAKFAST = "早餐";
var T_LUNCH = "午餐";
var T_DINNER = "晚餐";
var T_SNACK = "加餐";

/**
 * 内置类型。睡眠是唯一"双时刻"类型（一行存入睡 + 起床），其余都是计数型：一次一条、带时刻、可选备注。
 * 用户可以往注册表里加自己的计数类型（settings.types），所以解析不能写死名单。
 */
var BUILTIN_TYPES = [
  { name: T_SLEEP, icon: "bed", group: "sleep", short: "睡", hue: 248, locked: true },
  { name: T_WATER, icon: "droplet", group: "count", short: "水", hue: 198 }
];

/** 设置里那份就是全部生效类型；睡眠是唯一的双时刻类型，锁死不可删 */
function defaultTypes() {
  return BUILTIN_TYPES.map((t) => Object.assign({}, t));
}

/** 自定义类型可选图标：只列各版本 Obsidian 的 lucide 快照里都稳的名字 */
var ICON_CHOICES = ["activity", "heart", "dumbbell", "footprints", "droplet", "utensils", "coffee", "sun", "sunrise", "moon", "star", "book-open", "pill", "smile", "zap", "leaf"];

/**
 * 生效中的类型表（name → meta）。
 * 解析与格式化是一组纯函数、拿不到 settings，所以类型表在这里注入；
 * 插件加载和设置变更时调 setTypes 重建，默认等于内置表。
 */
var TYPE_MAP = {};
var TYPE_ORDER = [];

function registerType(meta) {
  if (!meta || !meta.name || TYPE_MAP[meta.name]) return;
  TYPE_MAP[meta.name] = meta;
  TYPE_ORDER.push(meta.name);
}

/**
 * 类型色相取自一组挑好的色板，按加入顺序轮着分配。
 * 之前是按名字散列，结果"早餐"抽出个绿、"晚餐"抽出个粉，白底上尤其脏；
 * 现在这一组是照着深浅两色都能看的顺序排的，用户也能在管理里自己换。
 */
var HUE_PALETTE = [
  { hue: 198, name: "水蓝" },
  { hue: 32, name: "橙" },
  { hue: 262, name: "紫" },
  { hue: 150, name: "绿" },
  { hue: 205, name: "青灰" },
  { hue: 12, name: "珊瑚" },
  { hue: 320, name: "粉" },
  { hue: 88, name: "草绿" }
];

function setTypes(list) {
  TYPE_MAP = {};
  TYPE_ORDER = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.name !== "string") continue;
    const name = item.name.trim();
    if (!name || TYPE_MAP[name]) continue;
    const builtin = BUILTIN_TYPES.find((t) => t.name === name);
    if (builtin) {
      // 内置的"水"也能换图标、换颜色、切成问内容：以前这里整只用 BUILTIN_TYPES 重建，
      // 管理里改完 commit 一走就被打回原样——设置里存了，界面上不认
      registerType(Object.assign({}, builtin, {
        icon: item.icon || builtin.icon,
        hue: Number.isFinite(item.hue) ? item.hue : builtin.hue,
        ask: item.ask !== undefined ? !!item.ask : !!builtin.ask,
        on: item.on !== false
      }));
      continue;
    }
    const slot = TYPE_ORDER.length % HUE_PALETTE.length;
    registerType({ name, icon: item.icon || "activity", group: "count", short: (item.short || name).slice(0, 3), hue: Number.isFinite(item.hue) ? item.hue : HUE_PALETTE[slot].hue, ask: !!item.ask, on: item.on !== false });
  }
  if (!TYPE_MAP[T_SLEEP]) registerType(Object.assign({}, BUILTIN_TYPES[0]));
}

setTypes(defaultTypes());

function typeMeta(name) {
  return TYPE_MAP[name] || null;
}

function isSleepType(name) {
  const meta = TYPE_MAP[name];
  return !!meta && meta.group === "sleep";
}

/** 计数型类型名（不含睡眠），顺序即快记网格与周表列序 */
function countTypes() {
  return TYPE_ORDER.filter((n) => TYPE_MAP[n].group !== "sleep");
}

var WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];

// ==================== 时间工具模块 ====================

/** 补零只发生在输出侧：解析一律容忍手写的不补零写法 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 本地日期串 YYYY-MM-DD（不能用 toISOString：它在 UTC 日界附近会错一天） */
function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthIdOfDate(dateStr) {
  return dateStr.slice(0, 7);
}

function nowTimeStr() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 解析 HH:MM / H:MM，非法返回 null */
function parseTimeText(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function normalizeTimeText(raw) {
  const p = parseTimeText(raw);
  return p ? `${pad2(p.hh)}:${pad2(p.mm)}` : null;
}

function timeToMinutes(text) {
  const p = parseTimeText(text);
  return p ? p.hh * 60 + p.mm : null;
}

/** 分只给 5 分钟一档的按钮，手打来的 47 先吸附到 45，选中态才有得亮 */
function snapMinute(m) {
  return Math.min(55, Math.max(0, Math.round(m / 5) * 5));
}

/** 校验 YYYY-M-D，并检查是否是该月真实存在的日期（2-30 这种要拒掉） */
function normalizeDateText(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

function dateFromStr(dateStr) {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

/** 周一为一周起点，与闪念笔记、月历任务的口径保持一致 */
function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setDate(d.getDate() - offset);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 睡眠时长：起床时刻不晚于入睡时刻即视为跨了午夜，补 24 小时。
 * 只记入睡未记起床（wake 为空）返回 null，由界面显示"待记录"。
 */
function sleepDuration(onset, wake) {
  const a = timeToMinutes(onset);
  const b = timeToMinutes(wake);
  if (a === null || b === null) return null;
  let diff = b - a;
  if (diff <= 0) diff += 1440;
  return diff;
}

/** 待起床最多还能接多久：超过一天再点「记录起床」，算出来的只可能是假时长 */
const PENDING_MAX_HOURS = 24;

/**
 * 一条只有入睡、没有起床的记录，从入睡到此刻过了多少小时。
 * 记录锚在入睡那晚（date + onset），跨午夜不用补——Date 直接按当天那个钟点算。
 */
function pendingAgeHours(record, now) {
  if (!record || !record.onset) return 0;
  const d = dateFromStr(record.date);
  const mins = timeToMinutes(record.onset);
  if (!d || mins === null) return 0;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60);
  return ((now || new Date()).getTime() - t.getTime()) / 3600000;
}

/** 入睡时刻在"夜晚轴"上的位置：18:00 记作 0，凌晨 2 点记作 8 小时 */
function nightPosition(minutesOfDay) {
  return (minutesOfDay - NIGHT_ORIGIN + 2880) % 1440;
}

/**
 * 这一记入睡该落在哪一晚：凌晨（12 点前）的那觉归前一晚，白天记的归当天；
 * 再按"这个钟点最近一次发生"往回退一天——早上 7 点填 23:40，是昨晚的 23:40。
 * 上一版按"18 点后归昨天、过零点归今天"一刀切，于是他凌晨 2 点醒来补录入睡，
 * 日期被翻成今天，卡片上出现"周二 02:00 入睡"这种不属于任何一晚的记录。
 * 偏移最多退一天：不然凌晨 1 点填 2 点会退成前天。
 */
function nightDateForOnset(timeStr, now) {
  const mins = timeToMinutes(timeStr);
  const base = now instanceof Date ? now : new Date();
  if (mins === null) return formatDate(base);
  const nowMins = base.getHours() * 60 + base.getMinutes();
  const offset = (mins <= nowMins ? 0 : -1) + (mins < 12 * 60 ? -1 : 0);
  return formatDate(addDays(base, Math.max(-1, offset)));
}

/** 睡眠条在夜晚轴上的起点与长度；跨午夜的起床时刻要加满一天才能接在同一条轴上 */
function sleepBarGeometry(onset, wake) {
  const a = timeToMinutes(onset);
  if (a === null) return null;
  const start = nightPosition(a);
  const duration = sleepDuration(onset, wake);
  if (duration === null) return { start, length: 0, pending: true };
  return { start, length: duration, pending: false };
}

function formatDuration(min) {
  if (min === null || min === undefined) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

/** 分钟数（可能超过一天）回到 HH:MM，夜晚轴上的刻度要用 */
function minutesToClock(min) {
  const wrapped = ((min % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}

function formatMonthLabel(monthId) {
  const parts = monthId.split("-");
  return `${parts[0]}年${Number(parts[1])}月`;
}

function formatDateLabel(dateStr) {
  const d = dateFromStr(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * Obsidian 内置的是某个时点的 lucide 快照，新版本才有的图标名在老版本上会画成空白。
 * 画完检查有没有 svg，没有就退回备用名，避免整排按钮变成一排空洞。
 */
function paintIcon(el, name, fallback) {
  try {
    (0, import_obsidian.setIcon)(el, name);
  } catch (e) {
    el.empty();
  }
  if (el.querySelector("svg")) return;
  if (!fallback) return;
  (0, import_obsidian.setIcon)(el, fallback);
}

// ==================== 记录模型与解析模块 ====================

function matchDayHeader(line) {
  const m = line.match(/^## (\d{4})-(\d{1,2})-(\d{1,2})(?=\s|$)/);
  if (!m) return null;
  return normalizeDateText(`${m[1]}-${m[2]}-${m[3]}`);
}

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(TYPE_MAP, type);
}

/** 一条记录行的文本表示（写盘用） */
/**
 * 备注里的竖线要换掉：一行是用竖线分列的，"可乐|薯片" 会写出四列，
 * 而四列以上的行按"用户自己写的内容"原样保留、不当记录读——
 * 结果就是这条记录在界面上消失，也删不掉。类型名那边已经拦了竖线，这边漏了。
 */
function sanitizeNote(raw) {
  return String(raw || "").replace(/\|/g, "｜").trim();
}

function formatRecordLine(record) {
  if (isSleepType(record.type)) {
    return record.wake ? `- ${record.type} | ${record.onset} | ${record.wake}` : `- ${record.type} | ${record.onset} |`;
  }
  const note = sanitizeNote(record.note);
  return note ? `- ${record.type} | ${record.time} | ${note}` : `- ${record.type} | ${record.time}`;
}

/**
 * 解析单行：只认无缩进的 `- 类型 | 时刻 [| 备注/起床]`，且类型必须在注册表里
 * （内置 + 用户自定义）。
 * 列数超过 3、类型没登记、时刻不合法都判为"用户自己的内容"，返回 null 让上层原样保留，
 * 绝不能把这类行当数据参与改写 —— 否则备注和自己写的清单会被静默吞掉。
 */
function parseRecordLine(line) {
  if (!line.startsWith("- ")) return null;
  const parts = line.slice(2).split("|").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const type = parts[0];
  if (!isKnownType(type)) return null;

  if (isSleepType(type)) {
    const onset = normalizeTimeText(parts[1]);
    if (!onset) return null;
    const wakeRaw = parts.length === 3 ? parts[2] : "";
    let wake = "";
    if (wakeRaw !== "") {
      wake = normalizeTimeText(wakeRaw);
      if (!wake) return null;
    }
    return { type, onset, wake };
  }

  const time = normalizeTimeText(parts[1]);
  if (!time) return null;
  return { type, time, note: parts.length === 3 ? parts[2] : "" };
}

/**
 * 长得像记录、但类型没在清单里的行。
 * 手工在文件里加了一行"- 早餐 | 08:05"而清单里没有"早餐"，插件不能当它不存在——
 * 那样界面上的条数和文件里的行数就对不上，还没处解释。认出来、原样显示、不计入统计。
 */
function parseUnregisteredLine(line) {
  if (!line.startsWith("- ")) return null;
  const parts = line.slice(2).split("|").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!normalizeTimeText(parts[1])) return null;
  return { type: parts[0], time: parts[1], note: parts.length === 3 ? parts[2] : "" };
}

/**
 * 哪些行在代码围栏里（``` 那两行本身也算进去）。
 * 读的那一侧一直不认围栏里的内容，写的那侧以前照旧认：文件里只要贴一段带
 * `## 2026-10-05` 的示例块（README 和设置页里就有现成的），新记录就会被写进围栏底下——
 * 那一行读不回来，界面上看不见、数不上、连删除键都不会出现。
 * 围栏状态在这里算一次，读写两侧共用同一份判据，别再各写各的。
 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) {
      open = !open;
      mask[i] = true;
      continue;
    }
    mask[i] = open;
  }
  return mask;
}

/** 解析整份月文件，返回带来源定位（行号 + 原文）的记录数组 */
function parseRecords(content, filePath) {
  const records = [];
  const lines = content.split(/\r?\n/);
  const mask = fenceMask(lines);
  let currentDate = null;
  const seen = new Map();

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i];
    const trimmed = line.trim();
    // H1（含文件标题）重置日期：其后未进入日期分区前的行不解析
    if (trimmed.startsWith("# ") && !trimmed.startsWith("## ")) {
      currentDate = null;
      continue;
    }
    const date = matchDayHeader(line);
    if (date !== null) {
      currentDate = date;
      continue;
    }
    // 认不出日期的二级标题也要收口。不重置的话，"## 小结" 下面手写的
    // `- 事项 | 12:30` 会被算成上一天的记录——而写入端找分区边界时是认 `## ` 的，
    // 读比写宽，那条记录既计进了昨天的数，又永远删不掉
    if (/^## /.test(trimmed)) currentDate = null;
    if (!currentDate) continue;

    let parsed = parseRecordLine(line);
    let unregistered = false;
    if (!parsed) {
      parsed = parseUnregisteredLine(line);
      if (!parsed) continue;
      unregistered = true;
    }

    // 同一天同一时刻同一内容的重复记录各占一个序号：既允许"真重复"，也让跨文件副本可去重
    const key = `${currentDate}|${formatRecordLine(parsed)}`;
    const occurrence = (seen.get(key) || 0) + 1;
    seen.set(key, occurrence);

    records.push(Object.assign({}, parsed, {
      date: currentDate,
      filePath,
      srcLine: i,
      srcText: line,
      occurrence,
      unregistered
    }));
  }
  return records;
}

/**
 * 同一天可能有不止一个分区：手工复制标题、或者两个工具各写一节，都会造出来。
 * 全部找出来（按出现顺序），删改要在所有节里找；新记录写最后一节。
 */
function findSections(lines, dateStr, mask) {
  const fenced = mask || fenceMask(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    if (matchDayHeader(lines[i]) !== dateStr) continue;
    let bodyEnd = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      // 一级标题也算边界：解析端遇到 `# ` 会重置日期（见 parseRecords），
      // 只认 `## ` 的话，"## 那天" 后面再来一个 "# 月度小结"，新记录会被插到小结底下
      if (!fenced[j] && (/^## /.test(lines[j]) || /^# (?!#)/.test(lines[j]))) {
        bodyEnd = j;
        break;
      }
    }
    out.push({ headerIdx: i, bodyEnd });
    i = bodyEnd - 1;
  }
  return out;
}

/** 新记录往哪一节里写：重复分区时取最后一节（后补的那节通常才是要用的），单节与旧行为一致 */
function findSection(lines, dateStr, mask) {
  const all = findSections(lines, dateStr, mask);
  return all.length ? all[all.length - 1] : null;
}

/** 记录在分区内排序用的键：睡眠按入睡时刻，其余按发生时刻 */
function recordSortKey(record) {
  return isSleepType(record.type) ? record.onset : record.time;
}

/**
 * 文件里某一行的排序键；不是记录的行返回 null（新记录不给它让位，它算正文）。
 * 认不出的类型（`- 奶茶 | 16:40`）也在内：读的那一侧把它当"未注册记录"列进明细，
 * 写的那一侧就得把它当记录，否则新记录会插到它前面、把它那一行挤下记录区。
 */
function lineSortKey(line) {
  const parsed = parseRecordLine(line) || parseUnregisteredLine(line);
  if (!parsed) return null;
  return normalizeTimeText(recordSortKey(parsed)) || null;
}

/**
 * 插入一条记录：已有当日分区则排到他最后一段正文的下面（区内按时刻排序），
 * 否则新建分区并按日期升序插入
 * （新建分区放文末会让补记把文件搞成乱序，手改时找不到北）
 */
/** 文件顶部的格式说明：半年后打开、或者整份丢给 AI，不看插件也能明白这些行是什么 */
var FILE_LEGEND = [
  "> 格式：一天一节，节标题是 `## YYYY-MM-DD 周几`；节里一行一条记录，写成 `- 类型 | 时间 | 备注`。",
  "> 睡眠的第三列是**起床时间**，不是备注；而且整条记在**入睡那晚**——`10-18` 下面的 `睡眠 | 23:40 | 07:10` 是 18 日深夜睡下、19 日早上起床。",
  "> 其余类型的第三列是内容或备注。插件认不出的行一律原样保留、不参与改写。",
  "> 想给某一天多写几句，用 `>` 引用块或普通段落：插件不读它、不显示它，新记录一律排在它下面，不会把那段话挪走。"
];
var LEGEND_MARK = "格式：一天一节";

/** 缺说明就补在标题下面。拿说明自己的文本当哨兵：补过一次就不会再补第二遍 */
function withLegend(lines) {
  if (lines.some((l) => l.indexOf(LEGEND_MARK) !== -1)) return lines;
  const mask = fenceMask(lines);
  // 围栏里的 `## 2026-10-05` 和 `# 标题` 是抄来的示例，不是文件的结构，
  // 照着它们定位会把说明插进别人的代码块里
  const firstDay = lines.findIndex((l, i) => !mask[i] && matchDayHeader(l) !== null);
  let h1 = lines.findIndex((l, i) => !mask[i] && /^# (?!#)/.test(l));
  // 只有"第一个日期分区之前"的大标题才算文件标题。手工文件里 `# 月度小结` 那种
  // 夹在中间，照原样找第一个 H1 会把说明插到正文里去
  if (h1 !== -1 && firstDay !== -1 && h1 > firstDay) h1 = -1;
  const body = lines.slice(h1 === -1 ? 0 : h1 + 1);
  while (body.length && body[0].trim() === "") body.shift();
  // 没有标题的文件（手工新建的、或者刚创建的）连标题一起补，别多留一行空行
  const head = h1 === -1 ? ["# 健康记录"] : lines.slice(0, h1 + 1);
  return [...head, "", ...FILE_LEGEND, "", ...body];
}

/** 新建文件时的开头：标题 + 格式说明，一次写全 */
function fileIntro() {
  return withLegend(["# 健康记录"]).join("\n") + "\n";
}

/** 日期分区标题带上星期：翻文件的人和接手处理的 AI 都不用再换算日子 */
function dayHeaderLine(dateStr) {
  const d = dateFromStr(dateStr);
  return `## ${dateStr} 周${WEEKDAY_SHORT[(d.getDay() + 6) % 7]}`;
}

/** 一节的正文末尾：最后一行有内容的地方（围栏里的行不算），新记录往这里追加 */
function sectionTail(lines, section, mask) {
  for (let i = section.bodyEnd - 1; i > section.headerIdx; i--) {
    if (mask[i] || lines[i].trim() === "") continue;
    return i + 1;
  }
  return section.headerIdx + 1;
}

function applyRecordInsert(content, dateStr, record, eol) {
  let lines = withLegend(content.split(/\r?\n/));
  const mask = fenceMask(lines);
  const lineText = formatRecordLine(record);
  const section = findSection(lines, dateStr, mask);

  if (section) {
    // 新记录锚在"他自己写的最后一段正文"之后，而不是锚在这一天的记录串上。
    // 他把备注写在记录下面（`>` 引用块、段落、他自己的清单都算正文）时，
    // 只要还往那串记录末尾插，他那句话就要被顶下去一行——一笔一笔顶，
    // 引用块越挪越远，还可能被顶出原来的段落。改成往本节末尾追加，
    // 他的话在文件里的位置一动不动。
    const key = normalizeTimeText(recordSortKey(record));
    let lastProse = -1;
    for (let i = section.headerIdx + 1; i < section.bodyEnd; i++) {
      if (mask[i] || lines[i].trim() === "") continue;
      if (lineSortKey(lines[i]) === null) lastProse = i;
    }
    // 正文把这一节切成两半：上面是他手写的（包括他先记了几笔又写的话），
    // 排序只在最后一段正文以下进行——补记一条早的时刻宁可排在末尾，也不越过他的话
    let insertAt = -1;
    let lastRecord = -1;
    for (let i = lastProse === -1 ? section.headerIdx + 1 : lastProse + 1; i < section.bodyEnd; i++) {
      if (mask[i]) continue;
      const at = lineSortKey(lines[i]);
      if (at === null) continue;
      lastRecord = i;
      // 按时刻插到该在的位置，而不是无脑追加：手工翻看文件时，一天的记录是排好序的
      if (insertAt === -1 && at > key) insertAt = i;
    }
    const atEnd = insertAt === -1;
    if (atEnd) insertAt = lastRecord === -1 ? sectionTail(lines, section, mask) : lastRecord + 1;
    const block = [lineText];
    if (atEnd) {
      // 只在"下面就是下一个日期标题"时补空行（标题紧贴列表，某些渲染器会把标题吞进列表里）。
      // 上面那道空行不补了：实测反馈"位置对了但多出一个空行"——他的引用块和记录之间
      // 本来就不空行，插件插一条也不该替他多留一格。
      const next = lines[insertAt];
      if (next !== undefined && next.trim() !== "") block.push("");
    }
    lines.splice(insertAt, 0, ...block);
  } else {
    let beforeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      const d = matchDayHeader(lines[i]);
      if (d === null) continue;
      if (d > dateStr) {
        beforeIdx = i;
        break;
      }
    }
    const block = [dayHeaderLine(dateStr), "", lineText];
    if (beforeIdx === -1) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      // 文件末尾还开着一个没闭合的围栏：新的一天不能写进围栏里——读侧不认围栏内的行，
      // 写进去就是"记了却看不见、删不掉"。先替他补一行闭合，再空一行起新分区
      if (lines.length && mask[lines.length - 1]) lines.push("```");
      lines.push("", ...block);
    } else {
      // 插到"下一个日期分区标题"之前：标题前本就有空行，段落间隔天然保持一个
      lines.splice(beforeIdx, 0, ...block, "");
    }
  }
  // 文件始终以换行结尾：手工编辑时游标不会停在半行上，diff 也少一格噪音
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  return lines.join(eol);
}

/**
 * 在指定日期分区内按原文定位一条记录。
 * srcLine 只是解析时的快照，两次点击之间文件可能被同步盘改写，所以先校验快照行、
 * 失效再按原文重搜；occurrence 用来在同日同内容的重复行里挑对第几条。
 */
/**
 * 一行的"身份"：能当记录读的行，按它解析后重新格式化出来的那一串算；认不出来的行返回 null。
 * 数重复（parseRecords 里的 occurrence）和定位某一条（locateRecord）必须同一套算法。
 * 以前一个用格式化后的串、一个拿原文逐字比，于是 `- 水 | 08:20` 和 `- 水 | 8:20`
 * 在前者算同一件事的两条（occurrence 1、2），在后者里各自只匹配到自己——
 * 第二条从此既删不掉也改不了，只会回一句"记录已被修改或不存在"。
 */
function lineIdentity(line) {
  const parsed = parseRecordLine(line) || parseUnregisteredLine(line);
  return parsed ? formatRecordLine(parsed) : null;
}

/** 定位某一条记录在文件里的行号；找不到返回 -1。同一天有多个分区时按出现顺序数 occurrence */
function locateRecord(lines, target, mask) {
  const fenced = mask || fenceMask(lines);
  const want = formatRecordLine(target);
  let n = 0;
  for (const section of findSections(lines, target.date, fenced)) {
    for (let i = section.headerIdx + 1; i < section.bodyEnd; i++) {
      // 围栏里的示例行不算记录，也不能被当成本体删改（解析端数序号时跳过了它们，这里必须同一套判据）
      if (fenced[i]) continue;
      const id = lineIdentity(lines[i]);
      // 整行认不出来的（用户自己的清单、四列的行）退回原文逐字比，
      // 这样"目标本身是原文"的情况仍然能定位，而漂移保护没被削弱
      if ((id === null ? lines[i] : id) !== want) continue;
      n++;
      if (n === (target.occurrence || 1)) return i;
    }
  }
  return -1;
}

function applyRecordRemove(content, target, eol) {
  const lines = content.split(/\r?\n/);
  const mask = fenceMask(lines);
  const idx = locateRecord(lines, target, mask);
  if (idx === -1) throw new Error("记录已被修改或不存在，请刷新后重试");
  lines.splice(idx, 1);
  return lines.join(eol);
}

function applyRecordUpdate(content, target, nextRecord, eol) {
  const lines = content.split(/\r?\n/);
  const mask = fenceMask(lines);
  const idx = locateRecord(lines, target, mask);
  if (idx === -1) throw new Error("记录已被修改或不存在，请刷新后重试");
  lines[idx] = formatRecordLine(nextRecord);
  return lines.join(eol);
}

// ==================== 记录管理器（数据读写） ====================

var RecordManager = class {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
    // 解析结果按文件缓存：三个视图同时刷新、或一分钟内反复切标签时不必每次重读重解析；
    // 任何外部或自己的写入都会清掉对应文件，5 秒只是同一批渲染内的去重窗口
    this.readCache = new Map();
    this.inFlight = new Map();
    // 写序号：读盘在途时一旦落了一次写（自己的或别人的），那份读结果就不许再进缓存
    this.writeSeq = 0;
    // 目录里"哪些文件算记录文件"的清单，比解析结果更便宜，但同样要跟着文件增删刷新
    this.filesCache = null;
    // 串行化本插件的写操作；与外部写入/同步盘的竞态交给 vault.process 的读改写原子性
    this.writeQueue = Promise.resolve();
    this.onSelfWrite = null;
  }

  enqueueWrite(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  invalidateCache() {
    this.readCache.clear();
    this.inFlight.clear();
    this.filesCache = null;
    this.writeSeq++;
  }

  dropFileCache(filePath) {
    this.readCache.delete(filePath);
    this.writeSeq++;
  }

  // ---------- 文件定位 ----------

  /** 归档方式由设置决定：按月是 `2026-10月健康记录.md`，按年是 `2026年健康记录.md` */
  recordFileName(dateStr) {
    return this.settings.archivePeriod === "year"
      ? `${dateStr.slice(0, 4)}年健康记录.md`
      : `${dateStr.slice(0, 7)}月健康记录.md`;
  }

  buildPath(name) {
    const folder = this.settings.storageFolder;
    return folder ? (0, import_obsidian.normalizePath)(`${folder}/${name}`) : (0, import_obsidian.normalizePath)(name);
  }

  /** 文件名以年份开头就算候选：`2026-10月…`、`2026年…`、老样式 `2026-10.md`、手工的 `2026-10-备份.md` */
  looksLikeRecordName(name) {
    // 同步盘的冲突副本（`2026-10月健康记录 1.md`）不认：它按定义就是同一份的复制，
    // 读进来只会让同一天的同一行在两处出现——去重时谁排前面算谁，
    // 于是新记录被写进那份没人看的副本里，删一条还有另一条站起来
    if (/ \d+\.md$/.test(name)) return false;
    return /^\d{4}/.test(name) && name.endsWith(".md");
  }

  async looksLikeRecordFile(file) {
    try {
      const content = await this.app.vault.cachedRead(file);
      return /^## \d{4}-\d{1,2}-\d{1,2}(?:\s|$)/m.test(content) && /^- \S+\s*\|\s*\d{1,2}:\d{2}/m.test(content);
    } catch (e) {
      return false;
    }
  }

  /**
   * 存储目录里所有"内容像记录文件"的 md。**认内容不认文件名**：
   * 换归档方式（月↔年）、改名、留个手工备份，都不该把老数据从界面上抹掉——
   * 而按月/按年只决定"新的一天下笔时落到哪个文件名"。
   */
  async recordFiles() {
    if (this.filesCache && Date.now() - this.filesCache.at < 5000) return this.filesCache.list;
    const folder = this.settings.storageFolder || "";
    const list = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const at = file.path.lastIndexOf("/");
      const dir = at === -1 ? "" : file.path.substring(0, at);
      if (dir !== folder || !this.looksLikeRecordName(file.name)) continue;
      if (await this.looksLikeRecordFile(file)) list.push(file.path);
    }
    list.sort();
    this.filesCache = { at: Date.now(), list };
    return list;
  }

  /**
   * 这一天该写进哪个文件：已经有它的那份优先。
   * 换了归档方式（月↔年）老日子还在老文件里，不该被劈成两半；都没有才按当期归档方式新建。
   * 代价是：如果谁在存储目录里手工留了一份"内容也像记录"的备份，这一天的记录可能被它带走。
   * 同步盘的冲突副本（`… 1.md`）已经在 looksLikeRecordName 里挡掉，剩下的只有手工改名这一种。
   */
  async resolveWritePath(dateStr) {
    const canonical = this.buildPath(this.recordFileName(dateStr));
    const records = await this.loadRange(dateStr, dateStr);
    if (records.some((r) => r.filePath === canonical)) return canonical;
    const home = records.find((r) => r.filePath);
    return home ? home.filePath : canonical;
  }

  async ensureDirectory(dirPath) {
    if (!dirPath) return;
    if (this.app.vault.getAbstractFileByPath(dirPath) instanceof import_obsidian.TFolder) return;
    const parent = dirPath.substring(0, dirPath.lastIndexOf("/"));
    if (parent) await this.ensureDirectory(parent);
    if (!this.app.vault.getAbstractFileByPath(dirPath)) {
      try {
        await this.app.vault.createFolder(dirPath);
      } catch (e) {
        if (!(this.app.vault.getAbstractFileByPath(dirPath) instanceof import_obsidian.TFolder)) throw e;
      }
    }
  }

  async ensureFile(filePath, initialContent) {
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof import_obsidian.TFile) return { file: existing, created: false };
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await this.ensureDirectory(dir);
    try {
      const file = await this.app.vault.create(filePath, initialContent);
      return { file, created: true };
    } catch (e) {
      const retry = this.app.vault.getAbstractFileByPath(filePath);
      if (retry instanceof import_obsidian.TFile) return { file: retry, created: false };
      throw e;
    }
  }

  // ---------- 原子改写 ----------

  /**
   * 读盘最新内容 → 纯函数改写 → 写回。
   * vault.process 是原子接口（不存在则先确保文件在），老版本回落到 read/modify；
   * 换行符按文件自身的风格回写，否则 CRLF 仓库里的记录文件会被整份改写、diff 爆炸。
   */
  async mutate(dateStr, mutateFn) {
    return this.enqueueWrite(async () => {
      const filePath = await this.resolveWritePath(dateStr);
      return this.writeFile(filePath, mutateFn);
    });
  }

  /**
   * 改写指定文件。删一条、改一条必须回到这条记录自己所在的那份文件：
   * 同一天可能同时出现在主文件与一份手工备份里，按日期重新解析只会挑到"第一份"，
   * 于是删了背景文件、界面上那条又从另一份里站起来（新记录也会写进错的那份）。
   * 文件已经不在了才退回按日期找。
   */
  async mutateFile(filePath, dateStr, mutateFn) {
    return this.enqueueWrite(async () => {
      const exists = this.app.vault.getAbstractFileByPath(filePath) instanceof import_obsidian.TFile;
      const path = exists ? filePath : await this.resolveWritePath(dateStr);
      return this.writeFile(path, mutateFn);
    });
  }

  /** 真正的读改写：vault.process 原子接口优先，老版本回落 read/modify；换行按文件自身风格回写 */
  async writeFile(filePath, mutateFn) {
    const ensured = await this.ensureFile(filePath, fileIntro());
    const file = ensured.file;
    let result;
    try {
      if (typeof this.app.vault.process === "function") {
        result = await this.app.vault.process(file, (content) => {
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          return mutateFn(content, eol);
        });
      } else {
        const content = await this.app.vault.read(file);
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const next = mutateFn(content, eol);
        await this.app.vault.modify(file, next);
      }
    } catch (e) {
      if (ensured.created) {
        try {
          await this.app.vault.delete(file);
        } catch (cleanupErr) {
          console.error(LOG + "清理新建文件失败:", cleanupErr);
        }
      }
      throw new Error(e && e.message ? e.message : String(e));
    }
    this.dropFileCache(filePath);
    if (ensured.created) this.filesCache = null;
    if (this.onSelfWrite) this.onSelfWrite(filePath);
    return result;
  }

  // ---------- 记录读写 ----------

  async addRecord(record) {
    const line = await this.mutate(record.date, (content, eol) => applyRecordInsert(content, record.date, record, eol));
    return line;
  }

  async removeRecord(target) {
    const fn = (content, eol) => applyRecordRemove(content, target, eol);
    if (target.filePath) await this.mutateFile(target.filePath, target.date, fn);
    else await this.mutate(target.date, fn);
  }

  async updateRecord(target, nextRecord) {
    const fn = (content, eol) => applyRecordUpdate(content, target, nextRecord, eol);
    if (target.filePath) await this.mutateFile(target.filePath, target.date, fn);
    else await this.mutate(target.date, fn);
  }

  /** 读并解析某一份文件；命中缓存或在途请求都不重复读盘 */
  async loadFile(filePath) {
    const cached = this.readCache.get(filePath);
    if (cached && Date.now() - cached.at < 5000) return cached.records;
    if (this.inFlight.has(filePath)) return this.inFlight.get(filePath);
    // 读之前记一笔写序号：读盘那几毫秒里可能刚好落了一次写，
    // 那种结果给出去一次就作废，不能再缓存 5 秒（否则界面显示旧数、文件却是新的）
    const seq = this.writeSeq;
    const run = (async () => {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof import_obsidian.TFile)) return [];
      try {
        return parseRecords(await this.app.vault.cachedRead(file), filePath);
      } catch (e) {
        console.error(LOG + "读取记录文件失败:", filePath, e);
        return [];
      }
    })();
    this.inFlight.set(filePath, run);
    try {
      const records = await run;
      if (seq === this.writeSeq) this.readCache.set(filePath, { at: Date.now(), records });
      return records;
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  /**
   * 读取 [start, end] 区间内的记录；文件缺失视为空区间，不创建文件。
   * 必须按日期过滤：分区写在错误的文件里时（改了归档方式、手工挪过），
   * 不过滤会让"本月"卡片列出上个月的数据。
   * 再去一次重：同一天的同一行在两处出现 = 同步盘的冲突副本，不是"记了两次"；
   * 真记了两次的是同一文件里的 occurrence 1 / 2，那个键本来就不同。
   */
  async loadRange(startStr, endStr) {
    const records = [];
    for (const path of await this.recordFiles()) records.push(...await this.loadFile(path));
    const seen = new Set();
    const out = [];
    for (const r of records) {
      if (r.date < startStr || r.date > endStr) continue;
      const key = `${r.date}|${formatRecordLine(r)}|${r.occurrence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || a.onset || "").localeCompare(b.time || b.onset || "")));
    return out;
  }

  /** 最近一晚未记起床的睡眠记录：往前找两天，覆盖"凌晨 1 点睡、上午 10 点起"这种正常作息 */
  async findPendingSleep(todayStr) {
    const records = await this.loadRange(formatDate(addDays(dateFromStr(todayStr), -2)), todayStr);
    // 超过 PENDING_MAX_HOURS 的"只有入睡"不再算可接的待起床：
    // 早上补记昨晚没问题，隔一天再点「记录起床」写出来的只可能是假时长
    const now = new Date();
    // 只认真正的睡眠行：`- 睡眠 | 07:00` 这种缺入睡时刻的坏行会被解析成"未注册的计数行"，
    // 它没有 onset，pendingAgeHours 当 0 算，一接起床就会把整行改成 `睡眠 |  | 起床` 并吞掉原时刻
    const pending = records.filter((r) => isSleepType(r.type) && !r.unregistered && r.onset && !r.wake && pendingAgeHours(r, now) <= PENDING_MAX_HOURS);
    if (!pending.length) return null;
    pending.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.onset < b.onset ? 1 : -1));
    return pending[0];
  }

  /** 超过时限、只记了入睡的那一条：让「记录起床」去修它，而不是再开一晚 */
  async findStalePending(todayStr) {
    const records = await this.loadRange(formatDate(addDays(dateFromStr(todayStr), -3)), todayStr);
    const now = new Date();
    const stale = records.filter((r) => isSleepType(r.type) && !r.unregistered && r.onset && !r.wake && pendingAgeHours(r, now) > PENDING_MAX_HOURS);
    if (!stale.length) return null;
    stale.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.onset < b.onset ? 1 : -1));
    return stale[0];
  }

  /** 今晚是否已有入睡记录（同一天只允许一条未完成的睡眠，重复点击直接忽略） */
  hasOnsetForDate(records, dateStr) {
    return records.some((r) => isSleepType(r.type) && r.date === dateStr && !r.wake);
  }
};

// ==================== 统计聚合 ====================

/** 把扁平记录聚成"按天"的结构，视图各区块共用一份 */
function groupByDay(records) {
  const map = new Map();
  for (const rec of records) {
    let day = map.get(rec.date);
    if (!day) {
      day = { date: rec.date, sleeps: [], byType: new Map(), unknown: [], total: 0 };
      map.set(rec.date, day);
    }
    if (rec.unregistered) {
      day.unknown.push(rec);
      continue;
    }
    // total 只数计数型那一侧：读的人一律写 `day.total + day.sleeps.length`，
    // 这里把睡眠也加进 total，一条睡眠就被算成两条（记一晚睡眠、条数显示 2、天数 1）
    if (isSleepType(rec.type)) day.sleeps.push(rec);
    else {
      let list = day.byType.get(rec.type);
      if (!list) {
        list = [];
        day.byType.set(rec.type, list);
      }
      list.push(rec);
      day.total++;
    }
  }
  return map;
}

/** 某天某类型的记录条数；类型被删掉后老数据仍在文件里，但这里查不到就是 0 */
function countOf(day, name) {
  const list = day && day.byType.get(name);
  return list ? list.length : 0;
}

/** 某天所有计数型记录，按时刻排好序（明细列表与总数统计共用） */
function countRecords(day) {
  if (!day) return [];
  const all = [];
  for (const list of day.byType.values()) all.push(...list);
  return all.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** 某天用于画条的睡眠：取入睡时刻最晚的那条（补记时可能有多条） */
function primarySleep(day) {
  if (!day || !day.sleeps.length) return null;
  const sorted = day.sleeps.slice().sort((a, b) => (a.onset < b.onset ? -1 : 1));
  return sorted[sorted.length - 1];
}

function average(values) {
  const nums = values.filter((v) => v !== null && v !== undefined);
  if (!nums.length) return null;
  return Math.round(nums.reduce((s, v) => s + v, 0) / nums.length);
}

// ==================== 趋势图（次数折线 / 睡眠区间条）====================

/**
 * 一条指标随日期的走势。SVG 手绘、不引库。
 * 断点比连线重要：没记录的那天就是断开，不用 0 去骗眼睛——
 * "这周有三天没记"和"这三天都是零"是两回事。
 */
var SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(parent, tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
  parent.appendChild(el);
  return el;
}

/**
 * 指标分两种画法：时长画横条，次数画折线。
 * 睡眠不适合折线——23:40 睡和 01:30 睡可以是同一个「7 小时」，折线把这个区别抹平了，
 * 而要看恰恰就是这个区别。横条一根说清三件事：几点睡、几点醒、睡了多久。
 */
var TREND_METRICS = [
  {
    key: "sleep", label: "睡眠", chart: "bar",
    // 读数用整分钟：以前换算成"小时保留一位小数"，顶部统计写 5小时59分、
    // 图下面写 6小时0分，同一周的两个平均数对不上
    valueOf(day) {
      const sleep = primarySleep(day);
      return sleep ? sleepDuration(sleep.onset, sleep.wake) : null;
    },
    format(v) { return v === null ? "—" : formatDuration(Math.round(v)); }
  },
  {
    // 条数要把睡眠也算进去：补记一晚睡眠同样是"记了一条"
    key: "count", label: "条数", chart: "line",
    valueOf(day) { return day && day.total + day.sleeps.length ? day.total + day.sleeps.length : null; },
    format(v) { return v === null ? "—" : v + " 条"; }
  }
];

/** 折线指标跟着用户自建类型走：加了几个类型，chip 上就多几个可看的次数曲线 */
function trendMetrics() {
  const out = TREND_METRICS.slice(0, 2);
  for (const type of pluginCountTypes()) {
    out.push({
      key: "type:" + type,
      // 芯片上写全名：缩写只有矩阵表头那种一格 40 像素宽的地方才不得不用
      label: (typeMeta(type) || {}).name || type,
      chart: "line",
      valueOf(day) { const n = countOf(day, type); return n ? n : null; },
      format(v) { return v === null ? "—" : v + " 次"; }
    });
  }
  return out;
}

/** 可见的计数类型（睡眠已在里面被排除）；视图与设置页共用，避免两处判断不一致 */
function pluginCountTypes() {
  return countTypes().filter((n) => TYPE_MAP[n].on !== false);
}

function renderTrend(host, days, opts) {
  const metric = opts.metric;
  // viewBox 按容器实际尺寸来：以前固定 300×132 再靠 preserveAspectRatio:none 拉伸，
  // 结果轴上的数字被横向拉扁——图对不对先不论，字是丑的
  const box = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
  const width = Math.max(180, Math.round(box && box.width ? box.width : 300));
  const height = Math.max(150, Math.round(box && box.height ? box.height : 200));
  const padL = 30, padR = 10, padT = 12, padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const values = days.map((entry) => metric.valueOf(entry.day));
  const present = values.filter((v) => v !== null);
  // 近 7 天画柱子（每天一根，比的是长短），近 30 天保留折线（看的是走势）——
  // 30 根柱子在手机上每根只剩 8px 左右，密成一道栅栏，长短反而比不出来。这轮的选择就是这个
  const asBar = days.length <= 7;
  const svg = svgEl(host, "svg", { viewBox: `0 0 ${width} ${height}`, class: "hr-trend", preserveAspectRatio: "none" });

  // 折线要两个点才连得起来；柱子一天有一根就画得成
  if (present.length < (asBar ? 1 : 2)) {
    const tip = svgEl(svg, "text", { x: width / 2, y: height / 2, class: "hr-trend-empty", "text-anchor": "middle" });
    tip.textContent = "这段时间的记录不足，画不出趋势";
    return svg;
  }

  let lo = Math.min(...present);
  let hi = Math.max(...present);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const pad = (hi - lo) * 0.18;
  // 柱子必须从 0 起画：折线可以把窗口挪到数据附近省空间，柱子的"长短"是在比大小，
  // 底下截掉一截，七根柱子看着就是齐平的高矮不分
  lo = asBar ? 0 : (metric.key === "count" ? Math.max(0, Math.floor(lo - pad)) : Math.floor((lo - pad) * 2) / 2);
  hi = metric.key === "count" ? Math.ceil(hi + pad) : Math.ceil((hi + pad) * 2) / 2;
  if (asBar && hi <= lo) hi = lo + 1;

  const stepX = days.length > 1 ? plotW / (days.length - 1) : 0;
  const xAt = (index) => padL + index * stepX;
  const yAt = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // 三条横向参考线，不画满刻度：侧栏本来就窄，格子一多就成噪音
  for (const gv of [lo, (lo + hi) / 2, hi]) {
    const y = yAt(gv);
    svgEl(svg, "line", { x1: padL, y1: y, x2: width - padR, y2: y, class: "hr-trend-grid" });
    const label = svgEl(svg, "text", { x: padL - 6, y: y + 3, class: "hr-trend-axis", "text-anchor": "end" });
    label.textContent = metric.key === "count" ? String(Math.round(gv)) : String(Math.round(gv * 10) / 10);
  }

  if (asBar) {
    const band = plotW / days.length;
    const bw = Math.max(6, Math.min(26, band * 0.52));
    const xc = (i) => padL + band * (i + 0.5);
    const base = yAt(lo);
    const todayStr = formatDate(new Date());
    values.forEach((v, i) => {
      const isToday = days[i].date === todayStr;
      if (v === null) {
        // 没记的那一天在底线上留一道淡痕：柱状图最怕把"漏记"画成"没有这一天"
        svgEl(svg, "line", { x1: (xc(i) - bw / 2).toFixed(1), y1: base, x2: (xc(i) + bw / 2).toFixed(1), y2: base, class: "hr-trend-none" });
        return;
      }
      const y = yAt(v);
      const bar = svgEl(svg, "rect", {
        x: (xc(i) - bw / 2).toFixed(1), y: y.toFixed(1),
        width: bw.toFixed(1), height: Math.max(2, base - y).toFixed(1),
        rx: Math.min(4, bw / 3).toFixed(1),
        class: "hr-trend-bar" + (isToday ? " is-today" : "")
      });
      // <title> 得挂在柱子自己身上才是这一根的提示，挂在 svg 上等于挂在整张图上
      svgEl(bar, "title").textContent = `${formatDateLabel(days[i].date)} ${metric.format(v)}`;
      bar.addEventListener("click", () => opts.onPickDay && opts.onPickDay(days[i].date));
      // 柱顶直接写次数：快记格子那枚数字角标这轮按他的选择撤了，
      // "今天到底记了几次"总得有个地方一眼读到
      const t = svgEl(svg, "text", { x: xc(i).toFixed(1), y: (y - 5).toFixed(1), class: "hr-trend-val" + (isToday ? " is-today" : ""), "text-anchor": "middle" });
      t.textContent = String(v);
    });
    for (const i of [0, days.length - 1]) {
      const t = svgEl(svg, "text", { x: xc(i), y: height - 4, class: "hr-trend-axis", "text-anchor": i === 0 ? "start" : "end" });
      t.textContent = formatDateLabel(days[i].date);
    }
    return svg;
  }

  // 折线按"连续有值"分段，中间断掉就不连
  let seg = [];
  const segments = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (seg.length > 1) segments.push(seg);
      seg = [];
    } else seg.push([xAt(i), yAt(v), i]);
  });
  if (seg.length > 1) segments.push(seg);
  for (const chain of segments) {
    svgEl(svg, "path", { d: "M " + chain.map((pt) => `${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(" L "), class: "hr-trend-line" });
  }

  values.forEach((v, i) => {
    if (v === null) return;
    const isToday = days[i].date === formatDate(new Date());
    const dot = svgEl(svg, "circle", { cx: xAt(i), cy: yAt(v), r: isToday ? 4 : 2.6, class: "hr-trend-dot" + (isToday ? " is-today" : "") });
    const tip = svgEl(dot, "title");
    tip.textContent = `${formatDateLabel(days[i].date)} ${metric.format(v)}`;
    dot.addEventListener("click", () => opts.onPickDay && opts.onPickDay(days[i].date));
  });

  // x 轴只标首尾：中间每一天是哪天，看横条那一列或者点上去看提示
  for (const i of [0, days.length - 1]) {
    const t = svgEl(svg, "text", { x: xAt(i), y: height - 4, class: "hr-trend-axis", "text-anchor": i === 0 ? "start" : "end" });
    t.textContent = formatDateLabel(days[i].date);
  }
  return svg;
}

/**
 * 睡眠区间条：每天一行，横条从入睡拉到起床。
 * 轴按"夜晚"排（18:00 在最左，次日中午在最右），跨午夜的那一觉就是一根连续的条，
 * 不需要像时钟刻度那样在 24:00 处断开。
 * 竖格线画在每一行的轨道背景里，不画在卡片上：卡片是 flex，绝对定位的格线会串到下面一张卡。
 */
function renderSleepBars(host, days, opts) {
  const todayStr = formatDate(new Date());
  const rows = days.map((entry) => {
    const sleep = entry.day ? primarySleep(entry.day) : null;
    return { date: entry.date, sleep, geo: sleep ? sleepBarGeometry(sleep.onset, sleep.wake) : null };
  });
  const withSleep = rows.filter((r) => r.geo);

  const wrap = host.createDiv({ cls: "hr-tl" });
  // 轴跟着数据走：作息固定的人不该看到一根 18 小时的空轴上只有一小截条。
  // 轴长只按"记全了的那几晚"算，未记起床的那晚另说（见下面画条的地方）。
  const starts = withSleep.map((r) => r.geo.start);
  const ends = withSleep.filter((r) => !r.geo.pending).map((r) => r.geo.start + r.geo.length);
  const lo = starts.length ? Math.floor(Math.min(...starts) / 180) * 180 : 0;
  // 轴要装得下每一条的**起点**，不只是终点。原来上限写死 18 小时，
  // 于是"傍晚一觉 + 深夜一觉"这种组合里，起晚的那条会被甩到 100% 之外：
  // 宽度算出负数、条画不出来，右边的字却照样写"17:30 → 18:30"，看着像图坏了。
  // 需要一整天就给一整天（作息被记乱的时候，一屏 24 小时轴本来就是对的）
  const maxStart = starts.length ? Math.max(...starts) : 0;
  const need = Math.max(ends.length ? Math.max(...ends) + 20 : 0, maxStart + 120);
  // 下限 9 小时：只有一晚记录时也不要把那一觉拉满整行
  const hi = Math.min(Math.max(Math.ceil(need / 180) * 180, lo + 540), lo + 1440);
  const span = hi - lo;
  const posPct = (min) => `${((min - lo) / span) * 100}%`;
  wrap.style.setProperty("--hr-tl-steps", String(span / 180));
  wrap.style.setProperty("--hr-tl-rows", String(rows.length));
  // 一周的行能塞下"几点到几点"，一个月的行只能塞下时长
  const wide = days.length <= 7;
  if (!wide) wrap.addClass("is-dense");

  const axis = wrap.createDiv({ cls: "hr-tl-row hr-tl-axis" });
  axis.createSpan({ cls: "hr-tl-day" });
  const ruler = axis.createDiv({ cls: "hr-tl-ruler" });
  for (let m = lo; m <= hi; m += 180) {
    const tick = ruler.createSpan({ cls: "hr-tl-tick", text: String(Number(minutesToClock(NIGHT_ORIGIN + m).slice(0, 2))) });
    tick.style.setProperty("--pos", posPct(m));
  }
  axis.createSpan({ cls: "hr-tl-val" });

  for (const r of rows) {
    const d = dateFromStr(r.date);
    const row = wrap.createDiv({ cls: "hr-tl-row" });
    if (r.date === todayStr) row.addClass("is-today");
    row.createSpan({ cls: "hr-tl-day", text: wide ? WEEKDAY_SHORT[(d.getDay() + 6) % 7] : String(d.getDate()) });
    const track = row.createDiv({ cls: "hr-tl-track" });
    if (r.geo) {
      const bar = track.createDiv({ cls: "hr-tl-bar" + (r.geo.pending ? " is-pending" : "") });
      const len = r.geo.pending ? span - Math.max(0, r.geo.start - lo) : Math.max(r.geo.length, 18);
      const left = Math.min(100, Math.max(0, ((r.geo.start - lo) / span) * 100));
      bar.style.setProperty("--left", `${left}%`);
      bar.style.setProperty("--w", `${Math.min(100 - left, (len / span) * 100)}%`);
      if (!r.geo.pending) row.style.setProperty("--hr-level", String(Math.min(1, Math.max(0, (r.geo.length - 240) / 360))));
    }
    const min = r.sleep ? sleepDuration(r.sleep.onset, r.sleep.wake) : null;
    const text = !r.sleep
      ? "未记"
      : min === null
        ? (wide ? `${r.sleep.onset} → 未记` : r.sleep.onset)
        : wide ? `${r.sleep.onset} → ${r.sleep.wake}` : formatDuration(min);
    row.createSpan({ cls: "hr-tl-val" + (r.sleep ? "" : " is-off"), text });
    row.setAttribute("title", `${formatDateLabel(r.date)} ${r.sleep ? `${r.sleep.onset} → ${r.sleep.wake || "未记起床"}${min === null ? "" : `（${formatDuration(min)}）`}` : "没有睡眠记录"}`);
    // 条上直接改这一晚：折线上的点只是数据，这里的每一行本来就是一条记录
    row.addEventListener("click", () => opts.onPickRow(r.date, r.sleep));
  }
  return wrap;
}

// ==================== 视图模块 ====================

/**
 * 一页装不下所有东西，但一页也不该要人上下滚：
 * 每个标签页把自己那叠卡片拆成几个面板，底部一条切换钮换面板，
 * 面板撑满剩余高度——图也因此终于有了能看清的高度。
 */
var PANELS = {
  today: [["log", "记录"], ["list", "明细"]],
  week: [["sleep", "睡眠"], ["count", "次数"], ["matrix", "计数"], ["gaps", "缺口"]],
  month: [["sleep", "睡眠"], ["count", "次数"], ["rank", "最短"]]
};

var HealthRecordView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tab = plugin.settings.lastTab || "today";
    this.anchor = new Date();
    // 选中的日期：默认今天，从趋势图折线上的点跳回来时指向那一天
    this.date = formatDate(new Date());
    this.trendMetric = plugin.settings.trendMetric || "sleep";
    this.rendering = false;
    this.pendingRefresh = false;
    this.resizeObserver = null;
    this.timers = new Set();
  }

  getViewType() {
    return VIEW_TYPE_HEALTH;
  }

  getDisplayText() {
    return "健康记录";
  }

  getIcon() {
    return "activity";
  }

  async onOpen() {
    this.buildSkeleton();
    this.observeWidth();
    await this.render();
  }

  async onClose() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  observeWidth() {
    const root = this.rootEl;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    // 侧边栏宽度由用户拖拽决定，与屏幕宽度无关，只能用 ResizeObserver 判断窄不窄
    this.resizeObserver = new ResizeObserver(() => this.updateNarrowClass());
    this.resizeObserver.observe(root);
    this.updateNarrowClass();
  }

  updateNarrowClass() {
    const width = this.rootEl.clientWidth;
    const height = this.rootEl.clientHeight;
    // 窄栏阈值 400：手机全屏抽屉大约 390px 宽，按 360 判会漏掉最该适配的那一档
    if (width > 0 && width < 400) this.rootEl.addClass("is-narrow");
    else this.rootEl.removeClass("is-narrow");
    // 图是按容器实际尺寸画 viewBox 的，拖侧栏/转屏后要重画一次；
    // 差得太小就不折腾，避免每帧都重排
    if (this.lastSize && (Math.abs(this.lastSize.w - width) > 24 || Math.abs(this.lastSize.h - height) > 40)) {
      this.lastSize = { w: width, h: height };
      this.scheduleChartResize();
      return;
    }
    this.lastSize = { w: width, h: height };
  }

  scheduleChartResize() {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      void this.render();
    }, 220);
    this.timers.add(this.resizeTimer);
  }

  buildSkeleton() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("health-record");
    this.rootEl = container.createDiv({ cls: "hr-root" });
    // 头部固定两行：第一行标签页 + 补记，第二行日期或翻页。
    // 交给 flex-wrap 自己排会在手机上散成三行，白白吃掉一屏里最贵的顶部
    this.headerEl = this.rootEl.createDiv({ cls: "hr-header" });
    const topRow = this.headerEl.createDiv({ cls: "hr-header-row" });
    this.tabsEl = topRow.createDiv({ cls: "hr-tabs" });
    this.headerActions = topRow.createDiv({ cls: "hr-header-actions" });
    const subRow = this.headerEl.createDiv({ cls: "hr-header-row is-sub" });
    this.headerMeta = subRow.createDiv({ cls: "hr-header-meta" });
    this.navEl = subRow.createDiv({ cls: "hr-nav" });
    // 统计条 / 面板 / 切换条三段：只有中间那段会长短不一，所以只有它会缩
    this.statsEl = this.rootEl.createDiv({ cls: "hr-stats" });
    this.bodyEl = this.rootEl.createDiv({ cls: "hr-body" });
    this.segEl = this.rootEl.createDiv({ cls: "hr-seg" });
    this.buildTabs();
  }

  /** 当前标签页看的是哪个面板；记住每个标签页各自的选择 */
  currentPanel() {
    const defs = PANELS[this.tab];
    const saved = (this.plugin.settings.lastPanels || {})[this.tab];
    return defs.some((d) => d[0] === saved) ? saved : defs[0][0];
  }

  setPanel(key) {
    const map = Object.assign({}, this.plugin.settings.lastPanels);
    map[this.tab] = key;
    this.plugin.remember("lastPanels", map);
  }

  buildSeg() {
    this.segEl.empty();
    const defs = PANELS[this.tab];
    if (defs.length < 2) {
      this.segEl.addClass("hr-hidden");
      return;
    }
    this.segEl.removeClass("hr-hidden");
    const active = this.currentPanel();
    for (const [key, label] of defs) {
      const btn = this.segEl.createEl("button", { cls: "hr-seg-btn" + (key === active ? " is-on" : ""), text: label });
      btn.addEventListener("click", () => {
        if (key === active) return;
        this.setPanel(key);
        void this.render();
      });
    }
  }

  buildTabs() {
    this.tabsEl.empty();
    const rolling = this.rolling();
    const defs = [["today", "今日"], ["week", rolling ? "近 7 天" : "本周"], ["month", rolling ? "近 30 天" : "本月"]];
    for (const [key, label] of defs) {
      const btn = this.tabsEl.createEl("button", { cls: "hr-tab", text: label });
      if (key === this.tab) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        if (this.tab === key) {
          // 停在"今日"再点一次：跨过零点以后这一页可能还钉在昨天，这一下拨回今天
          if (key === "today" && this.date !== formatDate(new Date())) {
            this.date = formatDate(new Date());
            void this.render();
          }
          return;
        }
        this.tab = key;
        this.anchor = new Date();
        this.date = formatDate(new Date());
        this.plugin.remember("lastTab", key);
        void this.render();
      });
    }
  }

  /** 本周/本月才有左右翻页；今日页隐藏 */
  buildNav() {
    this.navEl.empty();
    if (this.tab === "today") {
      this.navEl.addClass("hr-hidden");
      return;
    }
    this.navEl.removeClass("hr-hidden");
    const pill = this.navEl.createDiv({ cls: "hr-nav-pill" });
    const mk = (icon, delta) => {
      const btn = pill.createEl("button", { cls: "hr-nav-btn", attr: { "aria-label": delta < 0 ? "上一段" : "下一段" } });
      paintIcon(btn, icon, "chevron");
      btn.addEventListener("click", () => {
        this.anchor = this.rolling()
          ? addDays(this.anchor, delta * this.windowDays())
          : this.tab === "week"
            ? addDays(this.anchor, delta * 7)
            : new Date(this.anchor.getFullYear(), this.anchor.getMonth() + delta, 1);
        void this.render();
      });
    };
    mk("chevron-left", -1);
    const label = pill.createSpan({ cls: "hr-nav-label" });
    mk("chevron-right", 1);
    if (!this.isCurrentPeriod()) {
      const back = this.navEl.createEl("button", { cls: "hr-text-btn is-small", text: this.rolling() ? "回到最近" : "回到本期" });
      back.addEventListener("click", () => {
        this.anchor = new Date();
        this.date = formatDate(new Date());
        void this.render();
      });
    }
    return label;
  }

  /** 一周/一月各是多少天，滚动模式翻页要用 */
  windowDays() {
    return this.tab === "week" ? 7 : 30;
  }

  rolling() {
    return this.plugin.settings.rangeMode !== "calendar";
  }

  rangeForTab() {
    if (this.tab !== "today") {
      if (this.rolling()) {
        // 滚动：窗口永远以"看的那一天"收尾。周一打开不再只剩今天一格，
        // 也不必往下翻半天才看到自己刚记的那一笔
        const end = this.anchor;
        const start = addDays(end, -(this.windowDays() - 1));
        return { start: formatDate(start), end: formatDate(end), startDay: start };
      }
      if (this.tab === "week") {
        const start = startOfWeek(this.anchor);
        return { start: formatDate(start), end: formatDate(addDays(start, 6)), startDay: start };
      }
      const start = startOfMonth(this.anchor);
      return { start: formatDate(start), end: formatDate(addDays(start, daysInMonth(start.getFullYear(), start.getMonth()) - 1)), startDay: start };
    }
    const today = this.date;
    return { start: today, end: today, startDay: dateFromStr(today) };
  }

  async render() {
    if (this.rendering) {
      this.pendingRefresh = true;
      return;
    }
    this.rendering = true;
    // 同一页、同一面板的重绘（改一条记录、文件落盘）要把滚动位置带回来：
    // 明细翻到第二十条点个修改，一刷新就弹回顶部，等于每次都得重新找
    const prevKey = this._renderKey || "";
    const prevPanel = this.bodyEl.querySelector(".hr-panel");
    const prevScroll = prevPanel ? prevPanel.scrollTop : 0;
    try {
      // 页签名跟着 rangeMode 变（近 7 天 ↔ 本周），所以每次渲染都重列一遍：
      // 设置里改完只刷视图不重跑 buildSkeleton，页签会停在旧名字配新窗口
      this.buildTabs();
      const range = this.rangeForTab();
      const records = await this.plugin.manager.loadRange(range.start, range.end);
      const byDay = groupByDay(records);
      this.renderHeader(range);
      const label = this.buildNav();
      if (label) {
        // 滚动模式下两端都是具体日子，写"2026年10月"会骗人（窗口经常跨月）
        label.setText(this.rolling() || this.tab === "week" ? this.weekLabel(range) : formatMonthLabel(monthIdOfDate(range.start)));
      }
      this.bodyEl.empty();
      this.statsEl.empty();
      this.buildSeg();
      // 相邻上下文：本周可能跨月且"今晚的睡眠"锚在昨天，今日页要看前一晚
      const context = this.tab === "today" ? await this.plugin.manager.loadRange(formatDate(addDays(dateFromStr(range.start), -3)), range.end) : [];
      if (this.tab === "today") await this.renderToday(byDay, groupByDay(context));
      else if (this.tab === "week") this.renderWeek(byDay, range);
      else this.renderMonth(byDay, range);
      const nextKey = `${this.tab}|${this.currentPanel()}|${this.date}|${formatDate(this.anchor)}`;
      this._renderKey = nextKey;
      if (prevKey === nextKey && prevScroll > 0) {
        const panel = this.bodyEl.querySelector(".hr-panel");
        if (panel) panel.scrollTop = prevScroll;
      }
    } catch (e) {
      console.error(LOG + "视图渲染失败:", e);
      this.bodyEl.empty();
      const err = this.bodyEl.createDiv({ cls: "hr-empty" });
      err.createDiv({ cls: "hr-empty-title", text: "读取失败" });
      err.createDiv({ cls: "hr-empty-sub", text: e && e.message ? e.message : "请重新打开侧边栏" });
    } finally {
      this.rendering = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.render();
      }
    }
  }

  /**
   * 跨零点。今日页停在昨天 → 翻到今天；周/月页的锚点还停在昨天 → 锚点前移。
   * 正在翻看旧日子的页面不动（他有意停在那儿）。
   */
  onDayRollover(prevDay) {
    if (this.tab === "today") {
      if (this.date === prevDay) this.date = formatDate(new Date());
    } else if (formatDate(this.anchor) === prevDay) {
      this.anchor = new Date();
    }
    void this.render();
  }

  refresh() {
    void this.render();
  }

  /** 当前看的是不是"最近"：不是的话翻页条上给一个回到最近 */
  isCurrentPeriod() {
    const now = new Date();
    if (this.rolling()) return formatDate(this.anchor) === formatDate(now);
    if (this.tab === "week") return formatDate(startOfWeek(this.anchor)) === formatDate(startOfWeek(now));
    return this.anchor.getFullYear() === now.getFullYear() && this.anchor.getMonth() === now.getMonth();
  }

  weekLabel(range) {
    // 紧凑写法：胶囊里换行会把整行头部撑成两屏高
    const a = dateFromStr(range.start);
    const b = dateFromStr(range.end);
    return `${a.getMonth() + 1}/${a.getDate()} - ${b.getMonth() + 1}/${b.getDate()}`;
  }

  renderHeader(range) {
    this.headerMeta.empty();
    const today = formatDate(new Date());
    if (this.tab === "today") {
      const d = dateFromStr(this.date);
      const title = this.headerMeta.createSpan({ cls: "hr-title" });
      title.createSpan({ text: formatDateLabel(this.date) });
      // 窄栏里"周几"最先该被挤掉，日期本身比它有用
      title.createSpan({ cls: "hr-title-week", text: ` 周${WEEKDAY_SHORT[(d.getDay() + 6) % 7]}` });
      if (this.date !== today) {
        const back = this.headerMeta.createEl("button", { cls: "hr-back-today", text: "返回今天" });
        back.addEventListener("click", () => {
          this.date = today;
          void this.render();
        });
      }
    }
    // 本周/本月不再重复写标题：标签页已经说明在看哪一页，这行留给翻页条
    this.headerActions.empty();
    const more = this.headerActions.createEl("button", { cls: "hr-text-btn" });
    const moreIcon = more.createSpan({ cls: "hr-text-btn-icon" });
    paintIcon(moreIcon, "pen-line", "pencil");
    more.createSpan({ text: "补记" });
    // 预填"看到的那一天"。按日历切法下 range.end 是周日 / 月末，直接拿来预填
    // 等于先给用户塞一个未来的日子，保存再被"未来的日子还没有可记的"挡回去
    more.addEventListener("click", () => {
      const todayStr = formatDate(new Date());
      const day = this.tab === "today" ? this.date : range.end;
      this.openEditor({ date: day > todayStr ? todayStr : day });
    });
  }

  // ---------- 今日 ----------

  async renderToday(byDay, contextByDay) {
    const day = byDay.get(this.date) || { date: this.date, sleeps: [], byType: new Map(), total: 0 };
    // 今日页同样要装进面板：直接写进 bodyEl 的话，明细一长就被 overflow:hidden 裁掉，
    // 看着像"只有十条记录"，其实是后面看不见了
    const host = this.bodyEl.createDiv({ cls: "hr-panel" });
    if (this.currentPanel() === "list") {
      this.renderDayList(day, host);
      return;
    }
    const night = this.resolveNight(day, contextByDay);
    this.renderSleepCard(day, night, host);
    if (this.date === formatDate(new Date())) this.renderQuickGrid(day, host);
  }

  /**
   * 这一格该看哪一晚：优先当天自己记的；没有就往前 3 天找。
   * 记录锚在入睡那晚，所以早上打开时"昨晚那觉"挂在昨天——睡眠卡和睡眠条必须看同一个答案，
   * 否则会出现卡片显示 7 小时、条上却没有那一晚。
   */
  resolveNight(day, contextByDay) {
    const latest = (list) => (list.length ? list.slice().sort((a, b) => (a.onset < b.onset ? -1 : 1)).pop() : null);
    const own = latest(day.sleeps);
    if (own) return { record: own, label: `${formatDateLabel(day.date)} 那一晚`, borrowed: false, pending: !own.wake };
    // 今天这一页只往前借一晚：再往前借就会把"前天那一觉"顶在早上第一屏，
    // 而昨晚还没记这件事反而没地方点（他 10-21 早上要记的正是昨晚）。
    // 翻旧日子的页面仍借三天——那是回看，不是录入
    const backLimit = this.date === formatDate(new Date()) ? 1 : 3;
    for (let back = 1; back <= backLimit; back++) {
      const key = formatDate(addDays(dateFromStr(day.date), -back));
      const prev = contextByDay.get(key);
      const sleep = prev ? primarySleep(prev) : null;
      if (sleep) return { record: sleep, label: `${formatDateLabel(key)} 夜里`, borrowed: true, pending: !sleep.wake };
    }
    return null;
  }

  /**
   * 睡眠卡四态：待记起床 / 已记全 / 今天还没记 / 翻到没记的一天。
   * 记录锚在「入睡那晚」，所以早上打开时那条待补的记录挂在昨天：
   * 先看今天这一格，再往前 3 天找未补全的那晚，最后才回看上一晚的完整记录。
   */
  renderSleepCard(day, night, host) {
    const card = (host || this.bodyEl).createDiv({ cls: "hr-card hr-sleep-card" });
    // 四个角各摆一样：左上＝睡了多久，右上＝改这一条的入口，左下＝入睡→起床那串时刻，
    // 右下＝今晚还要点的那一下。上一版两枚按钮全堆在右下角，右上和左下同时空着——
    // 这轮指着截图说"修改的左面和记录睡眠的右上角，也就是左下和右上，目前都是空着的"
    const head = card.createDiv({ cls: "hr-sleep-head" });
    const main = head.createDiv({ cls: "hr-sleep-main" });
    const top = main.createDiv({ cls: "hr-sleep-top" });
    const valueEl = top.createDiv({ cls: "hr-sleep-value" });
    const unitEl = top.createDiv({ cls: "hr-sleep-unit" });
    const isToday = this.date === formatDate(new Date());
    // 每一态只声明"这一格放什么"，摆位置交给最后那一段统一做。DOM 顺序由构造决定，
    // 才不会再出上一轮那种事：acts 先建、芯片后追加，而 acts 靠 margin-left:auto 撑右，
    // 自动外边距推的是"它和它后面的所有东西"，芯片被一起顶到最右边，排成"按钮在左、时刻在右"
    const notes = [];      // 左上那一栏底下的小字（时长不像真的那种警告）
    const headActs = [];   // 右上角：改这一条
    const footActs = [];   // 右下角：今晚还要点的那一下
    let chip = null;       // 左下角的时刻芯片
    let hint = null;       // 左下角没有芯片时占位的说明

    // 只有入睡、没有起床，而且已经过了一天：这一条不再接「记录起床」。
    // 旧逻辑两天内都能接，于是"周一 02:00 的入睡"会被周二或周三的起床封口，
    // 算出来是个假时长（Date 差再取模 24 小时，看着还挺像真的）
    const staleHours = night && night.pending ? Math.round(pendingAgeHours(night.record, new Date())) : 0;
    const stalePending = !!(night && night.pending && staleHours > PENDING_MAX_HOURS);
    if (night && night.pending) {
      valueEl.createSpan({ text: night.record.onset });
      unitEl.setText(stalePending ? "这一晚没记起床" : night.borrowed ? "昨夜已入睡" : "今晚已入睡");
      if (stalePending) {
        notes.push({ cls: "hr-sleep-warn", text: `只记了入睡，已经过去 ${staleHours} 小时——不再自动接起床，点「补上起床」把时刻填进去` });
        headActs.push({ icon: "pen-line", label: "补上起床", run: () => this.openEditor({ existing: night.record }), cls: "hr-btn-primary" });
      } else {
        // 只有一下要点、也没有时刻要摆，就别硬撑第二行：「记录起床」直接守在右上角
        headActs.push({ icon: "bed-double", label: "记录起床", run: () => this.plugin.recordWake(), cls: "hr-btn-primary" });
      }
    } else if (night) {
      const min = sleepDuration(night.record.onset, night.record.wake);
      const h = Math.floor(min / 60);
      const m = min % 60;
      valueEl.createSpan({ text: h === 0 ? String(m) : String(h) });
      valueEl.createSpan({ cls: "hr-sleep-value-sub", text: h === 0 ? "分" : m ? `小时${m}分` : "小时" });
      unitEl.setText(night.label);
      // 两个时刻合成一枚"19:00 → 03:20"：分着写两枚芯片，加上动作，一屏就吃掉五分之一
      chip = `${night.record.onset} → ${night.record.wake}`;
      headActs.push({ icon: "pen-line", label: "修改", run: () => this.openEditor({ existing: night.record }), cls: "hr-btn-inline" });
      if (min > 840 || min < 90) {
        notes.push({ cls: "hr-sleep-warn", text: "这个时长不像真的，多半是某一头记错了" });
      }
      // 睡前那一记撤了。他两轮都说"很少有人睡着时还打开手机点一下"，
      // 留着它反而在凌晨 2 点给出一个没有意义、还会把前一段顶掉的按钮。
      // 「记录入睡」还在命令面板里，真要用的人仍然调得到
    } else if (!isToday) {
      valueEl.createSpan({ text: "—" });
      unitEl.setText("尚未记录睡眠");
      headActs.push({ icon: "pen-line", label: "补记这一晚", run: () => this.openEditor({ type: T_SLEEP, date: this.date }), cls: "hr-btn-primary" });
    } else {
      valueEl.createSpan({ text: "—" });
      unitEl.setText("尚未记录睡眠");
      // 早上唯一该做的动作：醒来点一下，起床取现在、入睡照上一晚填（弹窗里还标着这个数是猜的），
      // 不准就在同一个弹窗里改——不再要求任何人在睡前点手机
      hint = "睡前不用点；醒来点「我醒了」，入睡照上一晚填，不准就改";
      headActs.push({ icon: "sunrise", label: "我醒了", run: () => void this.plugin.openSleepMakeup(), cls: "hr-btn-primary" });
    }

    for (const n of notes) main.createDiv({ cls: n.cls, text: n.text });
    if (headActs.length) {
      const edit = head.createDiv({ cls: "hr-sleep-edit" });
      for (const a of headActs) this.addButton(edit, a.icon, a.label, a.run, a.cls);
    }
    if (chip || hint || footActs.length) {
      const foot = card.createDiv({ cls: "hr-sleep-foot" });
      if (chip) foot.createDiv({ cls: "hr-time-chip", text: chip });
      else if (hint) foot.createDiv({ cls: "hr-sleep-hint", text: hint });
      if (footActs.length) {
        const acts = foot.createDiv({ cls: "hr-sleep-acts" });
        for (const a of footActs) this.addButton(acts, a.icon, a.label, a.run, a.cls);
      }
    }
  }

  addButton(parent, icon, label, handler, cls) {
    const btn = parent.createEl("button", { cls: "hr-btn " + (cls || "hr-btn-ghost") });
    const iconEl = btn.createSpan({ cls: "hr-btn-icon" });
    paintIcon(iconEl, icon, "circle");
    btn.createSpan({ cls: "hr-btn-label", text: label });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    });
    return btn;
  }

  renderQuickGrid(day, host) {
    const section = (host || this.bodyEl).createDiv({ cls: "hr-section" });
    const head = section.createDiv({ cls: "hr-section-head" });
    head.createSpan({ cls: "hr-section-title", text: "快速记录" });
    const manage = head.createEl("button", { cls: "hr-quiet-btn", text: "管理类型" });
    manage.addEventListener("click", () => new TypeManagerModal(this.app, this.plugin).open());

    const grid = section.createDiv({ cls: "hr-quick-grid" });
    for (const type of this.plugin.visibleTypes()) {
      const meta = typeMeta(type);
      const btn = grid.createEl("button", { cls: "hr-quick" });
      btn.style.setProperty("--hue", String(meta.hue));
      const iconEl = btn.createSpan({ cls: "hr-quick-icon" });
      paintIcon(iconEl, meta.icon, "circle");
      btn.createSpan({ cls: "hr-quick-label", text: meta.name });
      const count = countOf(day, type);
      // 深浅表意，不写数字（这轮选的）：格子铺一层自己那枚色相，记一次深一档、
      // 四档封顶。上一版一档只加 5%，他说"颜色变化其实并不明显"——
      // 大多类型一天也就点两三次，档差太小等于没有。精确次数仍在 aria-label／长按提示里
      btn.style.setProperty("--hr-quick-level", String(Math.min(count, 4)));
      if (count) btn.addClass("is-done");
      btn.addEventListener("click", () => this.plugin.quickRecord(type));
      btn.setAttribute("aria-label", `记录${meta.name}（今天已 ${count} 次）`);
      btn.title = `${meta.name}：今天 ${count} 次`;
    }
  }

  renderDayList(day, host) {
    const section = (host || this.bodyEl).createDiv({ cls: "hr-section" });
    const head = section.createDiv({ cls: "hr-section-head" });
    head.createSpan({ cls: "hr-section-title", text: `${formatDateLabel(day.date)}明细` });
    const total = day.total + day.sleeps.length;
    head.createSpan({ cls: "hr-section-count", text: String(total) });

    // 未注册的那些行不进 total（口径是"不计入统计"），但空态不能因此把它们一起抹掉：
    // 有一天只手写了一行 `- 奶茶 | 16:40`，明细页整屏写"这一天还没有记录"，
    // 而缺口面板同一时间报着"1 行类型不在清单里"——两个面板互相打脸
    const unknownCount = (day.unknown || []).length;
    if (total === 0 && unknownCount === 0) {
      const empty = section.createDiv({ cls: "hr-empty" });
      const icon = empty.createDiv({ cls: "hr-empty-icon" });
      paintIcon(icon, "sparkles", "star");
      empty.createDiv({ cls: "hr-empty-title", text: "这一天还没有记录" });
      empty.createDiv({ cls: "hr-empty-sub", text: "上面的按钮点一下就记下来了" });
      return;
    }

    const rows = [];
    for (const rec of day.sleeps) {
      rows.push({ time: rec.onset, text: rec.wake ? `${rec.type} → ${rec.wake}` : `${rec.type}（待记起床）`, rec });
    }
    for (const rec of countRecords(day)) {
      rows.push({ time: rec.time, text: rec.type + (rec.note ? ` · ${rec.note}` : ""), rec });
    }
    for (const rec of day.unknown || []) {
      // 认得这是一行记录，只是类型不在清单里：列出来、标出来，别让它悄悄消失
      rows.push({ time: rec.time, text: `${rec.type}${rec.note ? ` · ${rec.note}` : ""}`, rec, unknown: true });
    }
    rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    const list = section.createDiv({ cls: "hr-list" });
    for (const row of rows) {
      const meta = typeMeta(row.rec.type) || { icon: "circle", hue: 210 };
      const item = list.createDiv({ cls: "hr-item" + (row.unknown ? " is-unknown" : "") });
      item.style.setProperty("--hue", String(meta.hue));
      item.createSpan({ cls: "hr-item-time", text: row.time });
      const iconEl = item.createSpan({ cls: "hr-item-icon" });
      paintIcon(iconEl, meta.icon, "circle");
      item.createSpan({ cls: "hr-item-text", text: row.text });
      if (row.unknown) item.createSpan({ cls: "hr-item-tag", text: "类型未注册" });
      // 定位到原文：明细里能改一句备注、能删一条，但真要写一大段（今天为什么只睡了
      // 四小时、药饭后有没有不舒服），那是文件里那个引用块的活，得把人送到那一行
      const jump = item.createDiv({ cls: "hr-item-btn", attr: { "aria-label": "在原文里定位" } });
      paintIcon(jump, "external-link", "arrow-up-right");
      jump.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openInFile(row.rec);
      });
      const edit = item.createDiv({ cls: "hr-item-btn", attr: { "aria-label": "修改" } });
      paintIcon(edit, "pen-line", "pencil");
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openEditor({ existing: row.rec });
      });
      // 删除要按两次：第一下只把垃圾桶染红，第二下才真删。
      // 撤销栈只管刚记的，删错了找不回来（这是清单里唯一不可逆的动作）
      const del = item.createDiv({ cls: "hr-item-btn hr-item-del", attr: { "aria-label": "删除" } });
      paintIcon(del, "trash-2", "x");
      let armed = false;
      let disarmTimer = 0;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          del.addClass("is-armed");
          del.setAttribute("aria-label", "再点一次确认删除");
          item.addClass("is-arming");
          disarmTimer = window.setTimeout(() => {
            armed = false;
            del.removeClass("is-armed");
            del.setAttribute("aria-label", "删除");
            item.removeClass("is-arming");
          }, 3000);
          return;
        }
        window.clearTimeout(disarmTimer);
        void this.plugin.removeRecord(row.rec);
      });
    }
  }

  // ---------- 复盘面板 ----------

  /**
   * 区间内逐日展开。未来的日子不列：那几天必然是空的，画进图里只会让趋势
   * 看着像"断了"，分母也跟着虚（16/31 其实是 16/17）。
   */
  daysInRange(range, byDay) {
    const start = dateFromStr(range.start);
    const endMs = Math.min(dateFromStr(range.end).getTime(), dateFromStr(formatDate(new Date())).getTime());
    const days = [];
    for (let d = new Date(start), i = 0; d.getTime() <= endMs; i++) {
      const key = formatDate(d);
      days.push({ date: key, day: byDay.get(key) || null });
      d = addDays(d, 1);
    }
    return days;
  }

  renderRangeStats(days) {
    const durations = [];
    let sleepDays = 0;
    let recordTotal = 0;
    let recordedDays = 0;
    for (const entry of days) {
      const day = entry.day;
      const sleep = day ? primarySleep(day) : null;
      if (sleep) {
        sleepDays++;
        const min = sleepDuration(sleep.onset, sleep.wake);
        if (min !== null) durations.push(min);
      }
      const n = day ? day.total + day.sleeps.length : 0;
      if (n) recordedDays++;
      recordTotal += n;
    }
    this.statCell(this.statsEl, "平均睡眠", durations.length ? formatDuration(average(durations)) : "—");
    this.statCell(this.statsEl, "记了睡眠", `${sleepDays} / ${days.length}`);
    this.statCell(this.statsEl, "记录条数", `${recordTotal} 条`);
    this.statCell(this.statsEl, "有记录", `${recordedDays} / ${days.length} 天`);
  }

  panelHead(host, title, note) {
    const head = host.createDiv({ cls: "hr-panel-head" });
    head.createSpan({ cls: "hr-section-title", text: title });
    if (note) head.createSpan({ cls: "hr-panel-note", text: note });
    return head;
  }

  renderSleepPanel(days) {
    const host = this.bodyEl.createDiv({ cls: "hr-panel" });
    const vals = [];
    let pending = 0;
    for (const entry of days) {
      const sleep = entry.day ? primarySleep(entry.day) : null;
      if (!sleep) continue;
      const min = sleepDuration(sleep.onset, sleep.wake);
      if (min === null) pending++;
      else vals.push(min);
    }
    const note = vals.length
      ? `最短 ${formatDuration(Math.min(...vals))} · 最长 ${formatDuration(Math.max(...vals))}${pending ? ` · ${pending} 晚未记起床` : ""}`
      : "还没有记全的晚上";
    this.panelHead(host, "入睡 → 起床", note);
    // 一个月三十行时倒着排：刚记的那一晚在顶上。按日历或近 7 天时保持从旧到新，
    // 那一屏本来就一眼看完，顺序反过来反而看不出走势
    const shown = days.length > 7 ? days.slice().reverse() : days;
    renderSleepBars(host.createDiv({ cls: "hr-tl-host" }), shown, {
      // 条上直接改这一晚：横条的每一行本来就是一条记录，不是折线上一个抽象的数据点
      onPickRow: (dateStr, sleep) => {
        if (sleep) this.openEditor({ existing: sleep });
        else this.openEditor({ type: T_SLEEP, date: dateStr });
      }
    });
  }

  renderCountPanel(days) {
    const host = this.bodyEl.createDiv({ cls: "hr-panel" });
    const metrics = trendMetrics().filter((m) => m.chart === "line");
    // 默认指标是"睡眠"，而睡眠不在折线这一组里：不回填的话面板里一个芯片都不高亮，
    // 看着像没选中任何东西
    let metric = metrics.find((m) => m.key === this.trendMetric);
    if (!metric) {
      metric = metrics[0];
      this.trendMetric = metric.key;
    }
    const head = this.panelHead(host, "次数", "");
    const chips = head.createDiv({ cls: "hr-chips" });
    for (const one of metrics) {
      const chip = chips.createEl("button", {
        cls: "hr-chip" + (metric.key === one.key ? " is-on" : ""),
        text: one.label
      });
      chip.addEventListener("click", () => {
        this.trendMetric = one.key;
        this.plugin.remember("trendMetric", one.key);
        void this.render();
      });
    }
    renderTrend(host.createDiv({ cls: "hr-trend-host" }), days, {
      metric,
      onPickDay: (dateStr) => {
        // 点一个数据点的意思是"看看那天到底记了什么"，所以直接落到明细面板
        this.date = dateStr;
        this.tab = "today";
        this.plugin.remember("lastTab", "today");
        this.setPanel("list");
        this.buildTabs();
        void this.render();
      }
    });
    const values = days.map((entry) => metric.valueOf(entry.day)).filter((v) => v !== null);
    host.createDiv({
      cls: "hr-panel-note",
      text: values.length
        ? `平均 ${metric.format(Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10)} · 最高 ${metric.format(Math.max(...values))} · ${values.length} / ${days.length} 天有`
        : "这段时间还没有可统计的记录"
    });
  }

  // ---------- 本周 ----------

  renderWeek(byDay, range) {
    const days = this.daysInRange(range, byDay);
    if (!days.length) {
      this.segEl.addClass("hr-hidden");
      this.bodyEl.createDiv({ cls: "hr-card hr-page-empty", text: "这一周还没到，先看本周或往回翻" });
      return;
    }
    this.renderRangeStats(days);
    const panel = this.currentPanel();
    if (panel === "sleep") this.renderSleepPanel(days);
    else if (panel === "count") this.renderCountPanel(days);
    else if (panel === "matrix") this.renderWeekCounts(days);
    else this.renderGaps(days);
  }

  /** 计数表：列是按可见性排好的计数类型，行是七天，格子里是当天条数 */
  renderWeekCounts(days) {
    const types = this.plugin.visibleTypes();
    const host = this.bodyEl.createDiv({ cls: "hr-panel" });
    if (!types.length) {
      this.panelHead(host, "计数", "");
      host.createDiv({ cls: "hr-empty-sub", text: "没有在显示的类型，去今日页的「管理类型」里打开一个或新建一个" });
      return;
    }
    this.panelHead(host, "计数", "格子里是当天的条数");

    const grid = host.createDiv({ cls: "hr-matrix" });
    grid.style.setProperty("--hr-cols", String(types.length));
    // 八个以上就缩到看不清了：给每列一个地板宽度并允许横向滑，色点让位给字
    if (types.length >= 8) grid.addClass("is-many");

    const headRow = grid.createDiv({ cls: "hr-mx-row hr-mx-head" });
    headRow.createSpan({ cls: "hr-mx-label" });
    for (const type of types) {
      const meta = typeMeta(type) || { hue: 210 };
      const cell = headRow.createSpan({ cls: "hr-mx-head-cell" });
      cell.style.setProperty("--hue", String(meta.hue));
      cell.createSpan({ cls: "hr-mx-head-text", text: (typeMeta(type) || { short: type }).short || type });
      cell.setAttribute("title", type);
    }

    for (const entry of days) {
      const d = dateFromStr(entry.date);
      const isToday = entry.date === formatDate(new Date());
      const row = grid.createDiv({ cls: "hr-mx-row" + (isToday ? " is-today" : "") });
      row.createSpan({ cls: "hr-mx-label", text: WEEKDAY_SHORT[(d.getDay() + 6) % 7] });
      for (const type of types) {
        const n = countOf(entry.day, type);
        const cell = row.createSpan({ cls: "hr-mx-cell" + (n ? "" : " is-zero"), text: n ? String(n) : "·" });
        cell.style.setProperty("--hue", String((typeMeta(type) || { hue: 210 }).hue));
      }
    }
  }

  /** 对不上的东西都归这里：没记的、没记全的、类型没注册所以不计数的。只说缺口，不做提醒 */
  renderGaps(days) {
    const gaps = [];
    for (const entry of days) {
      if (!entry.day) {
        gaps.push({ date: entry.date, text: "整天没记" });
        continue;
      }
      const sleep = primarySleep(entry.day);
      if (sleep && !sleep.wake) gaps.push({ date: entry.date, text: "未记起床", sleep });
      const n = (entry.day.unknown || []).length;
      if (n) gaps.push({ date: entry.date, text: `${n} 行类型不在清单里，没计入统计` });
    }
    const host = this.bodyEl.createDiv({ cls: "hr-panel" });
    this.panelHead(host, "缺口", gaps.length ? `${gaps.length} 处` : "");
    if (!gaps.length) {
      host.createDiv({ cls: "hr-empty-sub", text: "这段时间每天都记上了" });
      return;
    }
    const list = host.createDiv({ cls: "hr-list" });
    for (const gap of gaps) {
      // is-gap 让日期列自己撑开（CSS 里早就有这条，只是这一行一直没加类）：
      // 没有它，"10月18日"被塞进 40px 的 HH:MM 栏，12px 下折成两行
      const item = list.createDiv({ cls: "hr-item is-gap" });
      item.createSpan({ cls: "hr-item-time", text: formatDateLabel(gap.date) });
      item.createSpan({ cls: "hr-item-text", text: gap.text });
      if (!gap.sleep && /类型不在清单里/.test(gap.text)) {
        item.addClass("is-unknown");
      } else {
        const edit = item.createDiv({ cls: "hr-item-btn", attr: { "aria-label": "补这一晚" } });
        paintIcon(edit, "pen-line", "pencil");
        edit.addEventListener("click", (e) => {
          e.stopPropagation();
          if (gap.sleep) this.openEditor({ existing: gap.sleep });
          else this.openEditor({ type: T_SLEEP, date: gap.date });
        });
      }
    }
  }

  // ---------- 本月 ----------

  renderMonth(byDay, range) {
    const days = this.daysInRange(range, byDay);
    if (!days.length) {
      this.segEl.addClass("hr-hidden");
      this.bodyEl.createDiv({ cls: "hr-card hr-page-empty", text: "这个月还没到，往回翻一个月" });
      return;
    }
    this.renderRangeStats(days);
    const panel = this.currentPanel();
    if (panel === "sleep") this.renderSleepPanel(days);
    else if (panel === "count") this.renderCountPanel(days);
    else this.renderMonthRank(byDay, range);
  }

  /** 月内按睡眠时长排序：最差与最好的几晚，比平均值更能说明问题 */
  renderMonthRank(byDay, range) {
    const host = this.bodyEl.createDiv({ cls: "hr-panel" });
    const list = [];
    for (const [date, day] of byDay) {
      const sleep = primarySleep(day);
      if (!sleep) continue;
      const min = sleepDuration(sleep.onset, sleep.wake);
      if (min === null) continue;
      list.push({ date, min, sleep });
    }
    if (list.length < 3) {
      this.panelHead(host, "最短的几晚", "");
      host.createDiv({ cls: "hr-empty-sub", text: "记全三晚才有得排，现在只有" + list.length + "晚" });
      return;
    }
    list.sort((a, b) => a.min - b.min);
    const worst = list.slice(0, 3);
    const best = list.slice(-2).reverse();

    this.panelHead(host, "最短的几晚", "点一行改那一晚");
    const rows = host.createDiv({ cls: "hr-rank" });
    for (const item of worst) {
      const row = rows.createDiv({ cls: "hr-rank-row" });
      row.createSpan({ cls: "hr-rank-date", text: formatDateLabel(item.date) });
      row.createSpan({ cls: "hr-rank-value", text: formatDuration(item.min) });
      row.createSpan({ cls: "hr-rank-time", text: `${item.sleep.onset} → ${item.sleep.wake}` });
      row.addEventListener("click", () => this.openEditor({ existing: item.sleep }));
    }
    const bestRow = host.createDiv({ cls: "hr-rank-best" });
    bestRow.createSpan({ cls: "hr-section-hint", text: "最长的几晚：" });
    for (const item of best) bestRow.createSpan({ cls: "hr-rank-pill", text: `${formatDateLabel(item.date)} ${formatDuration(item.min)}` });
  }

  statCell(parent, label, value) {
    const cell = parent.createDiv({ cls: "hr-stat" });
    cell.createDiv({ cls: "hr-stat-value", text: value });
    cell.createDiv({ cls: "hr-stat-label", text: label });
  }

  openEditor(opts) {
    new RecordEditModal(this.app, this.plugin, opts).open();
  }

  /**
   * 打开记录文件并把光标放到那一行。行号是解析时记下的 srcLine（0 基），
   * 正好就是 Obsidian 编辑器 eState.line 要的格式，不用再换算。
   */
  openInFile(record) {
    const file = this.app.vault.getAbstractFileByPath(record.filePath);
    if (!(file instanceof import_obsidian.TFile)) {
      // 文件刚被改名或删掉：那份"哪些文件算记录文件"的清单立刻作废，
      // 别让下一次点击继续拿着旧路径找
      this.plugin.manager.filesCache = null;
      new import_obsidian.Notice(LOG + "找不到这份记录文件，可能刚被改名或删掉");
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    /* 行号必须跟着 openFile 一起交出去。以前那串是
       openFile() → view.getViewState() → 往 state.state.eState 里塞 line → view.setState(state, {history:false})，
       而 MarkdownView 的签名是 setState(state, eState)——**第二个参数才是元素状态**，
       我们传的却是 {history:false}，行号留在第一个参数里没人读，光标就停在文档开头
       （实测反馈：跳转按钮应该跳转到这一条所在位置，而不是只跳转到文档开头）。
       OpenViewState.eState 是官方入口，一步到位；文件本来就在这一格里打开着也照样落行 */
    void Promise.resolve(leaf.openFile(file, { eState: { line: record.srcLine } }))
      .catch((e) => new import_obsidian.Notice(LOG + "打不开记录文件：" + (e && e.message ? e.message : String(e))));
  }
};

// ==================== 日期选择弹窗 ====================

/**
 * 年/月翻页 + 日网格的日期选择器。
 * 交互照月历任务里那个（先选年月再点日），但样式改走 Obsidian 主题变量：
 * 那份是 430 行逐元素内联样式 + 写死的 slate 色板，直接搬过来会把深色主题下的
 * 卡片颜色钉死，且两套弹窗样式以后各改各的必然打架。
 */
var DatePickerModal = class extends import_obsidian.Modal {
  constructor(app, opts) {
    super(app);
    this.onPick = opts.onPick;
    this.value = normalizeDateText(opts.value) || formatDate(new Date());
    this.shown = dateFromStr(this.value);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("hr-picker");
    contentEl.createEl("h2", { text: "选择日期", cls: "hr-modal-title" });

    const quick = contentEl.createDiv({ cls: "hr-pick-quick" });
    const today = new Date();
    for (const [label, back] of [["今天", 0], ["昨天", 1], ["前天", 2], ["大前天", 3]]) {
      const target = formatDate(addDays(today, -back));
      const btn = quick.createEl("button", { cls: "hr-pick-quick-btn" + (target === this.value ? " is-on" : ""), text: label });
      btn.addEventListener("click", () => this.choose(target));
    }

    this.navEl = contentEl.createDiv({ cls: "hr-pick-nav" });
    this.gridEl = contentEl.createDiv({ cls: "hr-pick-grid" });
    this.paint();
  }

  paint() {
    const year = this.shown.getFullYear();
    const month = this.shown.getMonth();
    this.navEl.empty();
    const prev = this.navEl.createEl("button", { cls: "hr-pick-arrow", attr: { "aria-label": "上一月" } });
    paintIcon(prev, "chevron-left", "chevron");
    prev.addEventListener("click", () => {
      this.shown = new Date(year, month - 1, 1);
      this.paint();
    });
    this.navEl.createSpan({ cls: "hr-pick-title", text: `${year}年${month + 1}月` });
    const next = this.navEl.createEl("button", { cls: "hr-pick-arrow", attr: { "aria-label": "下一月" } });
    paintIcon(next, "chevron-right", "chevron");
    next.addEventListener("click", () => {
      this.shown = new Date(year, month + 1, 1);
      this.paint();
    });

    this.gridEl.empty();
    for (const w of WEEKDAY_SHORT) this.gridEl.createDiv({ cls: "hr-pick-week", text: w });
    const first = (new Date(year, month, 1).getDay() + 6) % 7;
    for (let i = 0; i < first; i++) this.gridEl.createDiv({ cls: "hr-pick-cell is-blank" });
    const total = daysInMonth(year, month);
    const todayStr = formatDate(new Date());
    for (let d = 1; d <= total; d++) {
      const key = `${year}-${pad2(month + 1)}-${pad2(d)}`;
      const cell = this.gridEl.createDiv({ cls: "hr-pick-cell", text: String(d) });
      if (key === todayStr) cell.addClass("is-today");
      if (key === this.value) cell.addClass("is-on");
      if (key > todayStr) {
        // 未来的日子点了也看不见（本周/本月都只列到今天），与其写进去一条读不出来的记录，
        // 不如根本点不动
        cell.addClass("is-future");
        continue;
      }
      cell.addEventListener("click", () => this.choose(key));
    }
  }

  choose(dateStr) {
    this.value = dateStr;
    if (this.onPick) this.onPick(dateStr);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
};

// ==================== 时间选择弹窗 ====================

var HOURS = [];
for (let h = 0; h < 24; h++) HOURS.push(h);
var MINUTES = [];
for (let m = 0; m < 60; m += 5) MINUTES.push(m);

/**
 * 时、分两排按钮的时间选择器。
 * 这里原来是一排"21 点 / 22 点 / 23 点 / 0 点…"的芯片按小时估。问题是入睡和起床
 * 本来就记在具体某分钟上（07:10 起床这种事没人会凑整），七个芯片只覆盖 7/1440 个
 * 取值，剩下还得手打——等于给了个装饰。改成 24 个时 + 12 个五分钟一档的分，
 * 点两下就出一个能用的时刻；手打这条路仍然留着，补记远日子时打字更快。
 */
var TimePickerModal = class extends import_obsidian.Modal {
  constructor(app, opts) {
    super(app);
    this.onPick = opts.onPick;
    this.titleText = opts.title || "选择时间";
    this.itemH = 40;
    // 手打来的值未必落在格子上（07:47），也未必补齐了位（9:5）。这里宽松地读进来
    // 只为了摆初始值——弹窗绝不"顺手改掉"用户已经打好的那一串，改了才叫事故
    const loose = String(opts.value || "").trim().match(/^(\d{1,2}):(\d{1,2})$/);
    if (loose && Number(loose[1]) <= 23 && Number(loose[2]) <= 59) {
      this.hour = Number(loose[1]);
      this.minute = Number(loose[2]);
    } else {
      const now = new Date();
      this.hour = now.getHours();
      this.minute = now.getMinutes();
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("hr-picker", "hr-time-picker");

    // 标题行：左边是标题，右边是「现在」
    const head = contentEl.createDiv({ cls: "hr-pick-head" });
    head.createEl("h2", { text: this.titleText, cls: "hr-modal-title" });
    const nowBtn = head.createEl("button", { cls: "hr-pick-now", text: "现在", attr: { type: "button" } });
    nowBtn.addEventListener("click", () => {
      const now = new Date();
      this.hour = now.getHours();
      this.minute = now.getMinutes();
      this.paint();
      this.syncWheels(false);
    });

    // 读数当主角
    this.readoutEl = contentEl.createDiv({ cls: "hr-time-hero" });

    // 时/分两列拨轮：上下滑，选中那行落在中间那条带里。
    // 上一版是 6 列数字格，一屏三十六个目标，他说"不喜欢这种格子选择"
    const wheels = contentEl.createDiv({ cls: "hr-time-wheels" });
    this.hourWheel = this.buildWheel(wheels, "时", HOURS, (v) => {
      this.hour = v;
      this.paint();
    });
    this.minWheel = this.buildWheel(wheels, "分", MINUTES, (v) => {
      this.minute = v;
      this.paint();
    });
    // 守卫与旧代码都按"一组可点的格子"找它们：接口保持不变，底层换成拨轮项
    this.hourCells = this.hourWheel.items;
    this.minCells = this.minWheel.items;

    const btns = contentEl.createDiv({ cls: "hr-modal-btns is-even" });
    btns.createEl("button", { cls: "hr-btn hr-btn-ghost", text: "取消", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    btns.createEl("button", { cls: "hr-btn hr-btn-primary", text: "确定", attr: { type: "button" } })
      .addEventListener("click", () => this.confirm());

    this.paint();
    // 等弹窗量出高度再把选中项滚到中间。只给一个 0ms 定时器不稳：Obsidian 的弹窗
    // 有时晚一帧才拿到高度，scrollTop 会被夹成 0。隔一帧再补一次，jsdom 里没有布局就跳过
    const kick = () => this.syncWheels(false);
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => window.setTimeout(kick, 30));
    } else {
      window.setTimeout(kick, 30);
    }
  }

  /** 一列拨轮：标签 + 视窗（含中间那条选中带）+ 可滚的按钮串 */
  buildWheel(parent, label, values, setValue) {
    const col = parent.createDiv({ cls: "hr-wheel" });
    col.createDiv({ cls: "hr-wheel-label", text: label });
    const view = col.createDiv({ cls: "hr-wheel-view" });
    view.createDiv({ cls: "hr-wheel-band" });
    const scrub = view.createDiv({ cls: "hr-wheel-scrub" });
    const items = [];
    for (const v of values) {
      const item = scrub.createEl("button", { cls: "hr-wheel-item", text: pad2(v), attr: { type: "button" } });
      item.addEventListener("click", () => {
        setValue(v);
        // 瞬移不带动画：平滑滚动会让滚动监听一路把读数改过去，数字在顶部跳一串
        this.scrollWheel(scrub, values.indexOf(v), false);
      });
      items.push({ value: v, el: item });
    }
    let timer = 0;
    scrub.addEventListener("scroll", () => {
      window.clearTimeout(timer);
      // 停下 80ms 才算"选好了"：滚动过程中每一帧都改读数，数字会一路闪
      timer = window.setTimeout(() => {
        const idx = Math.max(0, Math.min(values.length - 1, Math.round(scrub.scrollTop / this.itemH)));
        setValue(values[idx]);
      }, 80);
    });
    return { values, items, scrub, view };
  }

  scrollWheel(scrub, idx, smooth) {
    if (idx < 0) return;
    const top = idx * this.itemH;
    if (typeof scrub.scrollTo === "function") {
      scrub.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    } else {
      scrub.scrollTop = top;
    }
  }

  /** 把两列都滚到当前值的位置（分钟落最近的一档） */
  syncWheels(smooth) {
    this.scrollWheel(this.hourWheel.scrub, this.hourWheel.values.indexOf(this.hour), smooth);
    this.scrollWheel(this.minWheel.scrub, this.minWheel.values.indexOf(snapMinute(this.minute)), smooth);
  }

  paint() {
    this.readoutEl.setText(`${pad2(this.hour)}:${pad2(this.minute)}`);
    // 分钟只有 5 分钟一档：读数写实际那一分钟，亮的是最近的一档
    const near = snapMinute(this.minute);
    for (const c of this.hourCells) c.el.toggleClass("is-on", c.value === this.hour);
    for (const c of this.minCells) c.el.toggleClass("is-on", c.value === near);
  }

  confirm() {
    const time = `${pad2(this.hour)}:${pad2(this.minute)}`;
    if (this.onPick) this.onPick(time);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
};

// ==================== 补记 / 修改弹窗 ====================

var RecordEditModal = class extends import_obsidian.Modal {
  constructor(app, plugin, opts) {
    super(app);
    this.plugin = plugin;
    this.opts = opts || {};
  }

  onOpen() {
    const existing = this.opts.existing;
    const { contentEl } = this;
    contentEl.addClass("hr-modal");
    contentEl.createEl("h2", { text: existing ? "修改记录" : "补记一条", cls: "hr-modal-title" });

    const form = contentEl.createDiv({ cls: "hr-form" });

    const typeRow = form.createDiv({ cls: "hr-field" });
    typeRow.createDiv({ cls: "hr-field-label", text: "类型" });
    const chips = typeRow.createDiv({ cls: "hr-chip-row" });
    // 补记的默认类型取第一个"在显示"的计数型。以前写死"水"：把水隐藏或删掉之后，
    // 从页头点「补记」仍然默认选中水，保存就写出一条未注册行——不计统计、看着像丢了
    let selected = existing ? existing.type : (this.opts.type || this.plugin.visibleTypes()[0] || T_SLEEP);
    const paintChips = () => {
      chips.empty();
      // 隐藏的类型不进芯片列表（"已隐藏"就该哪儿都不出现），
      // 但改一条已有记录时它自己那一类必须在，否则点开看不出选的是谁
      const choices = TYPE_ORDER.filter((t) => TYPE_MAP[t].on !== false || t === selected);
      // 类型删掉之后文件里那些行原样留着，从明细里点开它时清单已经没这一类了——
      // 不补进选项，整排芯片一个都不亮，看着像"没选类型"，保存还会顺手把它写成未注册行
      if (selected && choices.indexOf(selected) === -1) choices.unshift(selected);
      for (const type of choices) {
        const chip = chips.createEl("button", { cls: "hr-chip-btn" + (type === selected ? " is-on" : ""), text: type });
        chip.addEventListener("click", () => {
          selected = type;
          paintChips();
          paintFields();
        });
      }
    };

    const dateField = this.makeField(form, "日期（填入睡那晚）", "text", "YYYY-MM-DD", existing ? existing.date : this.opts.date);
    this.attachPicker(dateField, { kind: "date", title: "选择日期" });
    const onsetField = this.makeField(form, "入睡时间", "text", "23:40", existing && isSleepType(existing.type) ? existing.onset : (this.opts.onset || ""));
    this.attachPicker(onsetField, {
      kind: "time",
      title: "选择入睡时间",
      onPick: (time) => this.snapDateForOnset(dateField, time, !!existing)
    });
    // 手打这条路以前绕过日期判定：同样填 02:00，点选择器会落到前一晚，手打却留在当天。
    // 只在日期还停在弹窗给的默认值时跟着动；他亲手改过日期就不再替他做主
    let dateTouched = false;
    dateField.input.addEventListener("input", () => { dateTouched = true; });
    onsetField.input.addEventListener("change", () => {
      if (!dateTouched) this.snapDateForOnset(dateField, onsetField.input.value, !!existing);
    });
    // 建议值要说清楚是猜的：不写这句，他会以为自己昨晚真点过 20:00
    onsetField.wrap.createDiv({
      cls: "hr-field-note",
      text: !existing && this.opts.onset
        ? `按上一晚 ${this.opts.onset} 填的，不准就在上面改`
        : "记不准就选个整点，比空着强"
    });
    const wakeField = this.makeField(form, "起床时间", "text", "07:10", existing && isSleepType(existing.type) ? existing.wake : (this.opts.wake || ""));
    this.attachPicker(wakeField, { kind: "time", title: "选择起床时间" });
    const timeField = this.makeField(form, "时间", "text", "08:20", existing && !isSleepType(existing.type) ? existing.time : (this.opts.time || ""));
    this.attachPicker(timeField, { kind: "time", title: "选择时间" });
    // 提示词不能写死"吃了什么 / 食堂"：清单是他自己的，加了「用药」「午休」之后，
    // 记一笔吃药却被告知"吃了什么"，等于界面在替他猜这一条是什么
    const noteField = this.makeField(form, this.opts.askNote ? "内容（可留空）" : "备注（可留空）", "text", "记一句", existing && !isSleepType(existing.type) ? existing.note : "");

    // 这一觉多长，边填边算：他常有"3 点醒、7 点才看手机"的情况，
    // 起床取的是点按钮的时刻，等保存完再发现多睡了四小时就晚了
    const sleepPreview = form.createDiv({ cls: "hr-sleep-preview hr-hidden" });
    const updatePreview = () => {
      if (!isSleepType(selected)) {
        sleepPreview.addClass("hr-hidden");
        return;
      }
      sleepPreview.removeClass("hr-hidden");
      const onset = normalizeTimeText(onsetField.input.value);
      const wake = normalizeTimeText(wakeField.input.value);
      if (!onset || !wake) {
        sleepPreview.setText("填完入睡和起床，这里会算出这一觉多长");
        sleepPreview.removeClass("is-warn");
        return;
      }
      const min = sleepDuration(onset, wake);
      const odd = min < 90 || min > 840;
      sleepPreview.setText(`这一觉 ${formatDuration(min)}（${onset} → ${wake}）` + (odd ? "——是不是有一头记错了？" : ""));
      sleepPreview.toggleClass("is-warn", odd);
    };
    for (const f of [onsetField, wakeField]) {
      f.input.addEventListener("input", updatePreview);
      f.input.addEventListener("change", updatePreview);
    }

    const paintFields = () => {
      const isSleep = isSleepType(selected);
      // "入睡那晚"这个提醒只在选睡眠时才有意义，挂在所有类型上会让人以为所有记录都要填昨天
      dateField.labelEl.setText(isSleep ? "日期（填入睡那晚）" : "日期");
      onsetField.wrap.toggleClass("hr-hidden", !isSleep);
      wakeField.wrap.toggleClass("hr-hidden", !isSleep);
      timeField.wrap.toggleClass("hr-hidden", isSleep);
      noteField.wrap.toggleClass("hr-hidden", isSleep);
      updatePreview();
    };

    paintChips();
    paintFields();

    const btns = contentEl.createDiv({ cls: "hr-modal-btns" });
    const save = btns.createEl("button", { cls: "hr-btn hr-btn-primary", text: "保存" });
    save.addEventListener("click", () => {
      // 写入要等盘，手快两下就是两条一模一样的记录（手机上尤其容易）
      if (this.saving) return;
      this.saving = true;
      save.disabled = true;
      void this.submit(existing, selected, dateField, onsetField, wakeField, timeField, noteField)
        .finally(() => {
          this.saving = false;
          save.disabled = false;
        });
    });
    btns.createEl("button", { cls: "hr-btn hr-btn-ghost", text: "取消" }).addEventListener("click", () => this.close());

    // 移动端优先聚焦第一个输入框，但 iOS 上程序化聚焦会顶起键盘遮挡内容，只在桌面做
    if (!import_obsidian.Platform.isMobile) {
      const target = isSleepType(selected) ? onsetField : (this.opts.askNote ? noteField : timeField);
      target.input.focus();
      if (this.opts.askNote) target.input.select();
    }
  }

  /**
   * 输入框右侧那枚按钮打开对应的选择器：手打 YYYY-MM-DD / HH:MM 太费劲，
   * 但手打这条路留着——补记几天前、或者只差一两分钟时，打字比点日历快。
   */
  attachPicker(field, opts) {
    const isTime = opts.kind === "time";
    const btn = field.row.createEl("button", { cls: "hr-pick-btn", attr: { type: "button", "aria-label": opts.title } });
    paintIcon(btn, isTime ? "clock" : "calendar", isTime ? "clock-3" : "calendar-days");
    btn.addEventListener("click", () => {
      const apply = (value) => {
        field.input.value = value;
        // 程序赋值不会触发 input 事件：补记窗的"这一觉多长"挂在 input 上，
        // 点完时钟必须自己派发一次，否则读数变了、时长还停在上一对时刻
        const win = field.input.ownerDocument.defaultView || window;
        field.input.dispatchEvent(new win.Event("input", { bubbles: true }));
        field.input.removeClass("is-error");
        if (opts.onPick) opts.onPick(value);
      };
      if (isTime) {
        new TimePickerModal(this.app, { value: field.input.value, title: opts.title, onPick: apply }).open();
      } else {
        new DatePickerModal(this.app, { value: field.input.value, onPick: apply }).open();
      }
    });
  }

  /**
   * 选的入睡时刻该不该把日期挪一挪。只挪两种情况，其余全部保留：
   * ①凌晨那觉只可能属于前一晚——上一版把它判成"今天"，于是他 2 点醒来补记，
   *   日期被翻成周二，写出"周二 02:00 入睡"这种没有归属的记录；
   * ②晚上这个钟点还没到，那记的只能是昨晚。
   * 下午的小睡、刚过去不久的晚上一律不动：日期框里已经写着昨天的人是在补记，
   * 再按"最近一次发生"去挪，会把补记改成今晚。
   * 只在日期还停在今昨这一格时动手，免得把补记几天前的日期改跑；
   * 改已有记录一律不挪——修改本来就不许换日期，挪了会撞在自己那条校验上。
   */
  snapDateForOnset(dateField, time, isEdit) {
    if (isEdit) return;
    const now = new Date();
    const todayStr = formatDate(now);
    const yestStr = formatDate(addDays(now, -1));
    const cur = dateField.input.value.trim();
    if (cur !== "" && cur !== todayStr && cur !== yestStr) return;
    const mins = timeToMinutes(time);
    if (mins === null) return;
    if (mins < 12 * 60) {
      dateField.input.value = yestStr;
      return;
    }
    const nowMins = now.getHours() * 60 + now.getMinutes();
    if (mins >= NIGHT_ORIGIN && nowMins < mins) dateField.input.value = yestStr;
  }

  /** 输入框单独包一层 row，日期那种"框 + 按钮"的组合才有地方放按钮 */
  makeField(parent, label, type, placeholder, value) {
    const wrap = parent.createDiv({ cls: "hr-field" });
    const labelEl = wrap.createDiv({ cls: "hr-field-label", text: label });
    const row = wrap.createDiv({ cls: "hr-field-row" });
    const input = row.createEl("input", { type, cls: "hr-input", placeholder, attr: { autocomplete: "off" } });
    if (value) input.value = value;
    this.keepAboveKeyboard(input);
    return { wrap, row, labelEl, input };
  }

  /**
   * 手机上输入法弹起来会盖住正在打的那一格，而 Obsidian 的弹窗不会自己跟着键盘走。
   * 只能盯 visualViewport：它的高度变化就是键盘进出，比猜键盘高度可靠；
   * 聚焦后也补一次，因为键盘弹起有动画，太早滚是滚到旧位置。
   */
  keepAboveKeyboard(input) {
    const scroll = () => {
      if (!input.isConnected || typeof input.scrollIntoView !== "function") return;
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    input.addEventListener("focus", () => this.later(scroll, 140));
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || typeof vv.addEventListener !== "function") return;
    // 视口变矮只在有软键盘时才值得跟：桌面上拖窗口大小不该把光标那格甩到中间
    const onResize = () => { if (import_obsidian.Platform.isMobile) this.later(scroll, 60); };
    vv.addEventListener("resize", onResize);
    // 每个输入框都装一个监听（补记窗五个字段），所以这里必须累加而不是覆盖：
    // 写成 this.vvStop = 的话 onClose 只摘得掉最后一个，其余四个监听连同已经拆掉的弹窗 DOM 一起留着
    this.vvStops = (this.vvStops || []).concat(() => vv.removeEventListener("resize", onResize));
  }

  async submit(existing, type, dateField, onsetField, wakeField, timeField, noteField) {
    const date = normalizeDateText(dateField.input.value || formatDate(new Date()));
    if (!date) return this.fail(dateField, "日期格式应为 YYYY-MM-DD");
    // 日期框可以手打，光在日历里拦不住
    if (date > formatDate(new Date())) return this.fail(dateField, "未来的日子还没有可记的");

    if (existing && date !== existing.date) {
      return this.fail(dateField, "修改记录不能换日期：请先删除，再补记到目标日期");
    }

    let record;
    if (isSleepType(type)) {
      const onset = normalizeTimeText(onsetField.input.value);
      if (!onset) return this.fail(onsetField, "入睡时间格式应为 HH:MM");
      const wakeRaw = wakeField.input.value.trim();
      let wake = "";
      if (wakeRaw !== "") {
        wake = normalizeTimeText(wakeRaw);
        if (!wake) return this.fail(wakeField, "起床时间格式应为 HH:MM");
      }
      // 两个时刻相同会被算成一整天，这种记录没有意义，直接让用户改一个
      if (wake && wake === onset) return this.fail(wakeField, "起床与入睡是同一时刻，请检查");
      record = { type: T_SLEEP, onset, wake };
    } else {
      const time = normalizeTimeText(timeField.input.value);
      if (!time) return this.fail(timeField, "时间格式应为 HH:MM");
      record = { type, time, note: noteField.input.value.trim() };
    }

    try {
      // 直接走 manager：插件上那层"顺手 catch 掉"的包装会让写失败也走到下面的"已修改"，
      // 于是同一屏先弹"记录已被修改或不存在"再弹"已修改"，改没改上根本说不清
      if (existing) await this.plugin.manager.updateRecord(existing, Object.assign(record, { date: existing.date }));
      else await this.plugin.manager.addRecord(Object.assign({ date }, record));
      this.close();
      new import_obsidian.Notice(existing ? "已修改" : "已记录");
      this.plugin.refreshAllViews();
    } catch (e) {
      this.fail(dateField, e && e.message ? e.message : "保存失败");
    }
  }

  fail(field, message) {
    field.input.addClass("is-error");
    field.wrap.querySelector(".hr-field-error")?.remove();
    field.wrap.createDiv({ cls: "hr-field-error", text: message });
    this.later(() => field.input.removeClass("is-error"), 1500);
  }

  later(fn, ms) {
    setTimeout(fn, ms);
  }

  onClose() {
    for (const stop of this.vvStops || []) stop();
    this.vvStops = null;
    this.contentEl.empty();
  }
};

// ==================== 类型管理弹窗 ====================

/**
 * 类型的增删与显隐。放在侧边栏网格的「管理」格里，不让人为了加个类型去钻设置页；
 * 设置页只留归档方式、记录文件位置这些一年调一次的东西。
 */
var TypeManagerModal = class extends import_obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    // 一次只展开一行：16 个图标 + 8 个颜色平铺在一行里，就是刚才那版
    // "五个控件挤进一条 Setting、每个都靠 tooltip 说明"的样子——手机上没有 hover，等于没说明
    this.openName = null;
    this.pendingDelete = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("hr-types");
    contentEl.createEl("h2", { text: "记录类型", cls: "hr-modal-title" });
    contentEl.createDiv({
      cls: "hr-field-note",
      text: "睡眠固定记「入睡 + 起床」两个时刻，其余都是计数型。类型名就是写进 Markdown 的那一列，改名等于换一个新类型，所以只能删不能改。"
    });
    this.listEl = contentEl.createDiv({ cls: "hr-type-list" });
    this.buildNewRow(contentEl.createDiv({ cls: "hr-type-new" }));
    this.paint();
  }

  summaryOf(meta) {
    if (meta.group === "sleep") return "双时刻类型 · 锁定";
    const slot = HUE_PALETTE.find((s) => s.hue === meta.hue);
    // 只写"跟默认不一样的地方"：每个计数类型都能切成问内容，把"只计数"当成状态写在
    // 每一行末尾，读起来像这类东西只能计数，得点开才知道其实可以换
    return [meta.on === false ? "已隐藏" : "", meta.ask ? "记时问内容" : "", slot ? slot.name : ""].filter(Boolean).join(" · ") || "计数类型";
  }

  paint() {
    this.listEl.empty();
    for (const item of this.plugin.settings.types) {
      const meta = typeMeta(item.name);
      if (!meta) continue;
      const locked = meta.group === "sleep";
      const open = !locked && this.openName === item.name;
      const row = this.listEl.createDiv({ cls: "hr-type-row" + (open ? " is-open" : "") });
      const head = row.createDiv({ cls: "hr-type-head" });
      const icon = head.createDiv({ cls: "hr-type-icon" });
      icon.style.setProperty("--hue", String(meta.hue));
      paintIcon(icon, meta.icon, "circle");
      const info = head.createDiv({ cls: "hr-type-info" });
      info.createDiv({ cls: "hr-type-name", text: item.name });
      info.createDiv({ cls: "hr-type-sub", text: this.summaryOf(meta) });
      if (locked) continue;
      // 顺序就是快记网格与周表的列序。做上下两枚箭头而不是拖拽：手机上的长按拖动
      // 会和列表滚动抢手势，箭头是确定点得中的；睡眠行锁定，不参与换位
      const moves = head.createDiv({ cls: "hr-type-moves" });
      const list = this.plugin.settings.types;
      const idx = list.findIndex((t) => t.name === item.name);
      const neighbor = (step) => {
        for (let i = idx + step; i >= 0 && i < list.length; i += step) {
          if (list[i].name !== T_SLEEP) return i;
        }
        return -1;
      };
      for (const [icon, label, step] of [["chevron-up", "上移", -1], ["chevron-down", "下移", 1]]) {
        const moveBtn = moves.createEl("button", { cls: "hr-move-btn", attr: { type: "button", "aria-label": label, title: label } });
        paintIcon(moveBtn, icon, "chevron");
        const to = neighbor(step);
        moveBtn.disabled = to < 0;
        moveBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (to < 0) return;
          const arr = list.slice();
          const [moving] = arr.splice(idx, 1);
          arr.splice(to, 0, moving);
          this.plugin.settings.types = arr;
          void this.commit();
        });
      }
      const caret = head.createDiv({ cls: "hr-type-caret" });
      paintIcon(caret, open ? "chevron-up" : "chevron-down", "chevron");
      head.addEventListener("click", () => {
        this.openName = open ? null : item.name;
        this.pendingDelete = null;
        this.paint();
      });
      if (open) this.buildOptions(row, item, meta);
    }
  }

  buildOptions(row, item, meta) {
    const body = row.createDiv({ cls: "hr-type-body" });

    body.createDiv({ cls: "hr-opt-label", text: "图标" });
    const icons = body.createDiv({ cls: "hr-icon-pick" });
    for (const name of ICON_CHOICES) {
      const btn = icons.createEl("button", { cls: "hr-icon-opt" + (name === meta.icon ? " is-on" : ""), attr: { type: "button", "aria-label": "图标 " + name } });
      paintIcon(btn, name, "circle");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        item.icon = name;
        await this.commit();
      });
    }

    body.createDiv({ cls: "hr-opt-label", text: "颜色" });
    const hues = body.createDiv({ cls: "hr-hue-pick" });
    for (const slot of HUE_PALETTE) {
      const dot = hues.createEl("button", { cls: "hr-hue-opt" + (slot.hue === meta.hue ? " is-on" : ""), attr: { type: "button", "aria-label": slot.name, title: slot.name } });
      dot.style.background = `hsl(${slot.hue} 55% 55%)`;
      dot.addEventListener("click", async (e) => {
        e.stopPropagation();
        item.hue = slot.hue;
        await this.commit();
      });
    }

    const acts = body.createDiv({ cls: "hr-type-acts" });
    acts.createEl("button", { cls: "hr-mini-btn", text: meta.on === false ? "显示出来" : "先隐藏" , attr: { type: "button" } })
      .addEventListener("click", async () => {
        item.on = meta.on === false;
        await this.commit();
      });
    acts.createEl("button", { cls: "hr-mini-btn" + (item.ask ? " is-on" : ""), text: item.ask ? "不问内容" : "问内容", attr: { type: "button" } })
      .addEventListener("click", async () => {
        item.ask = !item.ask;
        await this.commit();
      });
    const del = acts.createEl("button", { cls: "hr-mini-btn is-del" + (this.pendingDelete === item.name ? " is-armed" : ""), text: this.pendingDelete === item.name ? "确认删除" : "删除", attr: { type: "button" } });
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (this.pendingDelete !== item.name) {
        // 删掉之后文件里那些行不再被解析（原样保留），所以逼一次二次确认
        this.pendingDelete = item.name;
        this.paint();
        return;
      }
      this.plugin.settings.types = this.plugin.settings.types.filter((t) => t.name !== item.name);
      this.pendingDelete = null;
      this.openName = null;
      await this.commit();
    });
    if (this.pendingDelete === item.name) {
      body.createDiv({ cls: "hr-opt-note", text: `再点一次「确认删除」。文件里已有的「${item.name}」行原样留着，只是不再被读出来统计。` });
    }
  }

  /** 任何类型改动都要同时落设置与重建注册表，再刷视图 */
  async commit() {
    this.plugin.settings.types = this.plugin.normalizeTypes(this.plugin.settings.types);
    await this.plugin.saveSettings();
    this.plugin.refreshAllViews();
    this.paint();
  }

  buildNewRow(host) {
    host.createDiv({ cls: "hr-opt-label", text: "新建计数类型" });
    const line = host.createDiv({ cls: "hr-type-newline" });
    const input = line.createEl("input", { cls: "hr-row-input", attr: { type: "text", placeholder: "名字，例如 运动 / 吃药", maxlength: "8" } });
    const add = line.createEl("button", { cls: "hr-mini-btn is-primary", text: "添加", attr: { type: "button" } });
    const doAdd = async () => {
      const name = sanitizeTypeName(input.value);
      if (!name) return new import_obsidian.Notice(LOG + "类型名为空");
      if (isKnownType(name)) return new import_obsidian.Notice(LOG + `「${name}」已经存在`);
      const used = this.plugin.settings.types.length;
      this.plugin.settings.types = this.plugin.normalizeTypes([...this.plugin.settings.types, { name, icon: "activity", short: name.slice(0, 2), hue: HUE_PALETTE[used % HUE_PALETTE.length].hue, ask: false }]);
      // normalizeTypes 有 16 项上限，超了会静默丢掉——不回头查一遍就会提示"已添加"其实没加上
      if (!this.plugin.settings.types.some((t) => t.name === name)) {
        new import_obsidian.Notice(LOG + "类型最多 16 个，先删掉几个再加");
        return;
      }
      this.openName = name;
      input.value = "";
      // 走 commit 而不是自己 saveSettings：提示写着"点网格里的格子即可记录"，
      // 不刷视图的话那个格子要等弹窗关掉才出现
      await this.commit();
      new import_obsidian.Notice(`已添加「${name}」，点网格里的格子即可记录`);
    };
    add.addEventListener("click", () => void doAdd());
    // 手机上输入法回车是"上屏"不是"提交"，isComposing 判断必须留着，否则选词时会误提交
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) void doAdd();
    });
    host.createDiv({ cls: "hr-opt-note", text: "名字最多 8 个字，不能含竖线。全部类型合计最多 16 个（含睡眠），加完想换图标和颜色，点它的名字展开就有。" });
  }

  onClose() {
    this.contentEl.empty();
    this.plugin.refreshAllViews();
  }
};

// ==================== 设置 ====================

var DEFAULT_SETTINGS = {
  /** 记录文件放哪个目录：设置页扫描后点选，从没扫过时用这个默认位置 */
  storageFolder: "健康记录",
  /** 他在设置页亲手挑过目录——挑过就不再被自动扫描结果盖掉 */
  folderPicked: false,
  /** 归档粒度：month → `2026-10月健康记录.md`，year → `2026年健康记录.md` */
  archivePeriod: "month",
  /** 上次关视图时停在哪个标签页——记住就行，不是一道需要他选的题 */
  lastTab: "today",
  /** 每个标签页上次看的那个面板：{ today:"log", week:"sleep", month:"sleep" } */
  lastPanels: {},
  /** 上次复盘看的指标，同理 */
  trendMetric: "sleep",
  /** rolling = 近 7 天 / 近 30 天（窗口永远以今天收尾）；calendar = 按日历的本周 / 本月 */
  rangeMode: "rolling",
  /** 用户自建的计数类型：[{ name, icon, short }]，名字就是写进 markdown 的列，改名等于换类型 */
  types: []
};

/** 类型名要写进 markdown 的列，所以竖线、换行、首尾空格都不允许 */
function sanitizeTypeName(raw) {
  const name = String(raw || "").split("").filter((ch) => ch !== "|" && ch.charCodeAt(0) > 32).join("").trim().slice(0, 8);
  return name;
}

var HealthRecordSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hr-settings");
    containerEl.createEl("h2", { text: "健康记录设置" });

    // ---------- 复盘范围 ----------
    // 周一打开"本周"只有一格、月底打开"本月"要翻半天才看到今天，都是日历切法的代价；
    // 但"这周过得怎么样"确实有人要按日历算，所以做成一道选择而不是一处聪明
    containerEl.createEl("h3", { text: "复盘范围" });
    new import_obsidian.Setting(containerEl)
      .setName("本周 / 本月怎么算")
      .setDesc("动态：近 7 天、近 30 天，窗口永远以今天收尾，周一打开也是完整一周。按日历：本周从周一到周日、本月从 1 号到今天，和日历对得上。")
      .addDropdown((drop) => drop
        .addOption("rolling", "动态（近 7 天 / 近 30 天）")
        .addOption("calendar", "按日历（本周 / 本月）")
        .setValue(this.plugin.settings.rangeMode)
        .onChange(async (value) => {
          this.plugin.settings.rangeMode = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        }));

    // ---------- 记录文件 ----------
    // 这里刻意不放"打开时停在哪个页""趋势默认指标"：那两个是每次用都会改的偏好，
    // 视图里点一下就记住了，摆成设置项等于多两道没人愿意答的题。
    containerEl.createEl("h3", { text: "记录文件" });
    new import_obsidian.Setting(containerEl)
      .setName("归档方式")
      .setDesc("按月一个文件（2026-10月健康记录.md）还是按年一个文件（2026年健康记录.md）。切换只决定以后往哪个文件下笔，老文件原样留着、照样读得出来。")
      .addDropdown((drop) => drop
        .addOption("month", "按月")
        .addOption("year", "按年")
        .setValue(this.plugin.settings.archivePeriod)
        .onChange(async (value) => {
          this.plugin.settings.archivePeriod = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        }));

    const folderListEl = containerEl.createDiv({ cls: "hr-row-list" });
    const renderFolders = (hits) => {
      folderListEl.empty();
      const groups = this.plugin.groupFolders(hits || []);
      const current = this.plugin.settings.storageFolder || "";
      for (const entry of groups) {
        const row = folderListEl.createDiv({ cls: "hr-row" });
        if (entry.folder === current) row.addClass("is-current");
        const info = row.createDiv({ cls: "hr-row-main" });
        info.createDiv({ cls: "hr-row-name", text: entry.folder || "仓库根目录" });
        info.createDiv({ cls: "hr-row-sub", text: entry.count ? `发现 ${entry.count} 份记录文件` : (entry.folder === current ? "当前目录，还没有记录文件" : "新位置，第一次记录时自动创建") });
        if (entry.folder === current) {
          row.createDiv({ cls: "hr-row-tag", text: "使用中" });
          continue;
        }
        row.createEl("button", { cls: "hr-mini-btn", text: "选这里" }).addEventListener("click", async () => {
          this.plugin.settings.storageFolder = entry.folder;
          this.plugin.settings.folderPicked = true;
          await this.plugin.saveSettings();
          // 换目录等于换数据源：不重刷的话侧栏还停在旧目录那份读数上，
          // 看上去"换了个设置，记录却没变"，最容易被误会成没生效
          this.plugin.refreshAllViews();
          renderFolders(hits);
        });
      }
      if (!groups.some((g) => g.count)) {
        folderListEl.createDiv({ cls: "hr-row-sub", text: "库里还没有记录文件，第一次点记录时会在上面这个位置新建一份。" });
      }
    };

    let lastHits = [];
    // 文件被手工增删时，让这一份列表自己重画——不调 display()，
    // display() 会把整页重排、手机上直接跳回顶部
    this.plugin.repaintSettings = () => {
      if (!containerEl.isConnected) {
        this.plugin.repaintSettings = null;
        return;
      }
      void rescanQuiet();
    };
    const rescanQuiet = async () => {
      try {
        lastHits = await this.plugin.scanRecordFiles();
      } catch (e) {
        return;
      }
      renderFolders(lastHits);
    };
    const rescan = async () => {
      try {
        lastHits = await this.plugin.scanRecordFiles();
        // 扫描出来在哪就是在哪：只有一处有记录文件时直接认下来，不再让他确认一遍
        if (await this.plugin.adoptScannedFolder(lastHits)) {
          new import_obsidian.Notice("已按扫描结果定位记录文件");
        }
      } catch (e) {
        console.error(LOG + "扫描失败:", e);
        new import_obsidian.Notice(LOG + "扫描失败");
      }
      renderFolders(lastHits);
    };
    renderFolders(lastHits);
    void rescan();

    const scanRow = containerEl.createDiv({ cls: "hr-row hr-row-action" });
    scanRow.createDiv({ cls: "hr-row-main" }).createDiv({ cls: "hr-row-sub", text: "按内容特征查找记录文件（文件名以年份开头、里面有日期分区和记录行）。找到一处就自动定位，找到多处再点选。" });
    const scanBtn = scanRow.createEl("button", { cls: "hr-mini-btn", text: "重新扫描" });
    scanBtn.addEventListener("click", async () => {
      // 扫描要读每个候选文件，手机上可能卡一下：按钮先变灰并显示进度，免得以为没响应
      scanBtn.textContent = "扫描中…";
      scanBtn.disabled = true;
      await rescan();
      scanBtn.textContent = "重新扫描";
      scanBtn.disabled = false;
    });

    // ---------- 记录类型（入口在侧边栏，这里只留一句话）----------
    containerEl.createEl("h3", { text: "记录类型" });
    containerEl.createDiv({
      cls: "hr-setting-note",
      text: "增删类型、换图标换颜色、决定显示与否，都在侧边栏「今日 → 快速记录 → 管理类型」里做。类型名就是写进 Markdown 的那一列，改名等于换新类型，所以只能删不能改。"
    });

    // ---------- 数据格式 ----------
    const help = containerEl.createDiv({ cls: "hr-help" });
    help.createEl("h3", { text: "数据格式" });
    help.createEl("p", { text: "记录按「入睡那晚」归档：10-18 下的 23:40 → 07:10 表示 18 日晚睡、19 晨起。起床未记录时第三列留空。可以直接手工编辑，插件认不出的行会原样保留、不参与改写。" });
    const pre = help.createEl("pre", { cls: "hr-code" });
    pre.createEl("code", {
      text: `## 2026-10-18

- 睡眠 | 23:40 | 07:10
- 水 | 08:20
- 水 | 09:30
- 运动 | 07:00 | 五公里`
    });
  }
};



// ==================== 插件主类 ====================

var HealthRecordPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
  }

  async onload() {
    await this.loadSettings();
    this.manager = new RecordManager(this.app, this.settings, () => {
      void this.saveSettings();
    });
    this.manager.onSelfWrite = (filePath) => {
      // 记的是"哪一份文件、什么时候"，不是一个全局时间戳：
      // 只写一份文件时另一份的改动也会被那道 500ms 保护吞掉（同步盘落地、
      // 或者目录里同时有月和年的两份文件时最容易出现）
      this._lastSelfWrite = { path: filePath, at: Date.now() };
    };

    this.registerView(VIEW_TYPE_HEALTH, (leaf) => new HealthRecordView(leaf, this));
    this.addRibbonIcon("activity", "健康记录", () => void this.activateView());

    this.addCommand({ id: "open-health-record", name: "打开健康记录", callback: () => void this.activateView() });
    // 只登记"此刻还在类型清单里"的那几个：默认清单瘦身成睡眠 + 水之后，
    // 命令面板里留五条点了只会弹「类型不存在」的死命令是说不过去的。
    // 用户自己新建的同名类型也会拿到命令；反过来，Obsidian 没有卸载命令的 API，
    // 删掉的类型要到下次启动才从面板里消失。
    const quickCommands = [
      [T_WATER, "record-water", "记一杯水"],
      [T_TOILET, "record-toilet", "记一次如厕"],
      [T_BREAKFAST, "record-breakfast", "记早餐"],
      [T_LUNCH, "record-lunch", "记午餐"],
      [T_DINNER, "record-dinner", "记晚餐"],
      [T_SNACK, "record-snack", "记加餐"]
    ];
    for (const [type, id, name] of quickCommands) {
      if (TYPE_MAP[type]) this.addCommand({ id, name, callback: () => void this.quickRecord(type) });
    }
    this.addCommand({ id: "record-sleep-onset", name: "记录入睡", callback: () => void this.recordOnset() });
    this.addCommand({ id: "record-sleep-wake", name: "记录起床", callback: () => void this.recordWake() });
    this.addCommand({ id: "record-last-night-sleep", name: "记昨晚的睡眠（补记）", callback: () => this.openSleepMakeup() });
    this.addCommand({ id: "undo-last-record", name: "撤销上一条记录", callback: () => void this.undoLast() });
    this.addCommand({ id: "add-record-manually", name: "补记一条", callback: () => this.openManual() });
    this.addCommand({ id: "open-current-record-file", name: "打开当前记录文件", callback: () => void this.openCurrentFile() });

    this.registerEvent(this.app.vault.on("modify", (file) => this.handleFileChange(file, false)));
    this.registerEvent(this.app.vault.on("create", (file) => this.handleFileChange(file, true)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleFileChange(file, true)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.isOurFile(file.path) || this.isOurFile(oldPath)) {
        this.manager.invalidateCache();
        this.scheduleRefresh(200);
      }
    }));

    // 跨零点要把"今日"翻篇：Obsidian 不会因为日期变了重绘视图，只能自己盯
    this.lastDateStr = formatDate(new Date());
    this.registerInterval(window.setInterval(() => {
      const today = formatDate(new Date());
      if (today !== this.lastDateStr) {
        const prev = this.lastDateStr;
        this.lastDateStr = today;
        // 只 refresh 的话，停在"今日"的那一页还会钉在昨天：date 是视图自己的状态，
        // 不跟着跨过去就整页空白（快记格只在"今天是今天"时画），点当前页签又被 return 挡住
        this.rolloverTo(prev);
      }
    }, 60 * 1000));

    this.addSettingTab(new HealthRecordSettingTab(this.app, this));
  }

  onunload() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
  }

  // ---------- 设置 ----------

  async loadSettings() {
    let loaded = null;
    try {
      loaded = await this.loadData();
    } catch (e) {
      console.error(LOG + "设置读取失败，改用默认值:", e);
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
    this.settings.storageFolder = this.sanitizeFolder(this.settings.storageFolder);
    if (!["month", "year"].includes(this.settings.archivePeriod)) this.settings.archivePeriod = "month";
    if (!["rolling", "calendar"].includes(this.settings.rangeMode)) this.settings.rangeMode = "rolling";
    // 0.5 之前"停在哪个标签页"是一道设置项，现在改成记住上次关在哪儿，老数据直接搬过来
    const lastTab = this.settings.lastTab || this.settings.defaultTab;
    this.settings.lastTab = ["today", "week", "month"].includes(lastTab) ? lastTab : "today";
    delete this.settings.defaultTab;
    if (!(this.settings.lastPanels instanceof Object)) this.settings.lastPanels = {};
    // 老版本的 types 只存自建项，这里一律以整表为准重建：缺睡眠或空表时回落到默认清单
    if (!Array.isArray(this.settings.types) || !this.settings.types.length) this.settings.types = defaultTypes();
    else if (!this.settings.types.some((t) => t && t.name === T_SLEEP)) this.settings.types = [{ name: T_SLEEP }, ...this.settings.types];
    this.settings.types = this.normalizeTypes(this.settings.types);
    setTypes(this.settings.types);
    // 指标清单跟着类型走，所以要在 setTypes 之后校验：类型被删了，默认指标回落睡眠
    if (!trendMetrics().some((m) => m.key === this.settings.trendMetric)) this.settings.trendMetric = "sleep";
  }

  /** 类型表规范化：睡眠永远排第一且不可缺，其余去重去空，上限 16 项 */
  normalizeTypes(list) {
    const out = [];
    const seen = new Set();
    const sleep = (Array.isArray(list) ? list : []).find((t) => t && t.name === T_SLEEP);
    out.push(Object.assign({}, BUILTIN_TYPES[0], { on: sleep ? sleep.on !== false : true }));
    seen.add(T_SLEEP);
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.name !== "string") continue;
      const name = sanitizeTypeName(item.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const builtin = BUILTIN_TYPES.find((t) => t.name === name);
      const base = builtin ? Object.assign({}, builtin) : {};
      out.push(Object.assign(base, {
        name,
        icon: item.icon || base.icon || "activity",
        hue: Number.isFinite(item.hue) ? item.hue : base.hue,
        ask: !!item.ask,
        on: item.on !== false
      }));
      if (out.length >= 16) break;
    }
    return out;
  }

  /** 快记网格、计数表与趋势芯片要显示的类型（计数型且未关掉） */
  visibleTypes() {
    return pluginCountTypes();
  }

  /** 顺手记住一个偏好（停在哪个标签页、复盘看的哪个指标）。做成设置项是多余的：没人会想去改自己上次看的东西 */
  remember(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    void this.saveSettings();
  }

  async saveSettings() {
    setTypes(this.settings.types);
    this.manager.updateSettings(this.settings);
    this.manager.invalidateCache();
    if (this._saveChain) {
      this._saveChain = this._saveChain.catch(() => {}).then(() => this.saveData(this.settings));
    } else {
      this._saveChain = Promise.resolve().then(() => this.saveData(this.settings));
    }
    try {
      await this._saveChain;
    } catch (e) {
      console.error(LOG + "设置保存失败:", e);
      new import_obsidian.Notice(LOG + "设置保存失败");
    }
  }

  /** 与闪念笔记同一套目录校验：反斜杠转正斜杠、去重斜杠、拒 .. 段 */
  /**
   * 扫描仓库里的记录文件。判据和读盘时用的是同一套（文件名以年份开头 + 内容像记录文件），
   * 所以"扫描找到的"和"界面读得到的"永远一致——扫出来在 A 目录、界面却读不出数据，
   * 是最难自己发现的那种错。
   */
  async scanRecordFiles() {
    const hits = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.manager.looksLikeRecordName(file.name)) continue;
      try {
        if (await this.manager.looksLikeRecordFile(file)) {
          const at = file.path.lastIndexOf("/");
          hits.push({ path: file.path, folder: at === -1 ? "" : file.path.substring(0, at) });
        }
      } catch (e) {
        // 读不动的文件跳过，不让一次 IO 失败毁掉整次扫描
      }
    }
    return hits;
  }

  /**
   * 扫描出来在哪就是在哪：整个库只有一处放着记录文件时直接采用它，不用他再确认一次。
   * 只在"他没手动挑过位置"时生效——挑过就以他的选择为准，否则每次打开设置都会被扫回去。
   */
  async adoptScannedFolder(hits) {
    if (this.settings.folderPicked || !hits.length) return false;
    const folders = new Set(hits.map((h) => h.folder));
    if (folders.size !== 1) return false;
    const only = [...folders][0];
    if (only === (this.settings.storageFolder || "")) return false;
    this.settings.storageFolder = only;
    await this.saveSettings();
    this.refreshAllViews();
    return true;
  }

  /** 把扫描结果按目录归并成"目录 → 几份文件"，供设置页列表用 */
  groupFolders(hits) {
    const map = new Map();
    for (const hit of hits) map.set(hit.folder, (map.get(hit.folder) || 0) + 1);
    const current = this.settings.storageFolder || "";
    if (!map.has(current)) map.set(current, 0);
    return [...map.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .sort((a, b) => (b.count - a.count) || a.folder.localeCompare(b.folder));
  }

  sanitizeFolder(raw) {
    if (!raw) return "";
    const v = String(raw).trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
    if (v.includes("/../") || v === ".." || v.startsWith("../") || v.endsWith("/..")) {
      new import_obsidian.Notice(LOG + "存储目录不允许包含 .. 段");
      return "";
    }
    return v;
  }

  // ---------- 事件 ----------

  isOurFile(path) {
    if (!path || !path.endsWith(".md")) return false;
    const folder = this.settings.storageFolder;
    if (folder && !path.startsWith(folder + "/")) return false;
    return this.manager.looksLikeRecordName(path.substring(path.lastIndexOf("/") + 1));
  }

  handleFileChange(file, invalidate) {
    if (!(file instanceof import_obsidian.TFile)) return;
    if (!this.isOurFile(file.path)) return;
    // 增删改都可能让"目录里有哪些记录文件"的清单过期
    if (invalidate) this.manager.filesCache = null;
    // 自己写入触发的 modify 已经由调用处刷新，跳过以免闪一下。
    // 但这道保护只管 modify：删文件、新建文件永远不是自己的回声，
    // 之前一起挡掉，导致刚记完一笔再删掉整个文件时读数不动
    const sw = this._lastSelfWrite;
    if (!invalidate && sw && sw.path === file.path && Date.now() - sw.at < 500) return;
    this.manager.dropFileCache(file.path);
    // 设置页开着的时候那份目录列表也要跟着动，不然"发现 1 份记录文件"会一直挂着
    if (this.repaintSettings) this.repaintSettings();
    this.scheduleRefresh(300);
  }

  scheduleRefresh(delay) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refreshAllViews();
    }, delay);
  }

  refreshAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTH)) {
      if (leaf.view instanceof HealthRecordView) leaf.view.refresh();
    }
  }

  /** 跨零点：仍在看"当前这一天/这一周"的视图跟着往前挪一天，翻旧日子的不动 */
  rolloverTo(prevDay) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTH)) {
      if (leaf.view instanceof HealthRecordView) leaf.view.onDayRollover(prevDay);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_HEALTH)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    // 移动端没有稳定的右侧栏布局，getRightLeaf 可能返回 null，只能回退新建 leaf
    let leaf = workspace.getRightLeaf(false);
    if (!leaf) leaf = workspace.getLeaf(true);
    if (!leaf) {
      new import_obsidian.Notice(LOG + "无法打开视图，请重启 Obsidian 后重试");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_HEALTH, active: true });
    workspace.revealLeaf(leaf);
  }

  // ---------- 记录动作 ----------

  /**
   * 一键记录。餐类是"记内容"而不是"记次数"，所以标了 ask 的类型点开的是补记弹窗
   * （时间已填好，光标停在内容上），只留一个 +1 数字等于什么都没记。
   */
  async quickRecord(type) {
    if (!isKnownType(type) || isSleepType(type)) {
      new import_obsidian.Notice(LOG + "类型不存在：" + type);
      return;
    }
    const today = formatDate(new Date());
    if (typeMeta(type).ask) {
      new RecordEditModal(this.app, this, { type, date: today, time: nowTimeStr(), askNote: true }).open();
      return;
    }
    const record = { type, time: nowTimeStr(), note: "" };
    try {
      await this.manager.addRecord(Object.assign({ date: formatDate(new Date()) }, record));
      this._lastWrite = { date: formatDate(new Date()), srcText: formatRecordLine(record), type };
      new import_obsidian.Notice(`${type} ${record.time}`);
      this.refreshAllViews();
    } catch (e) {
      console.error(LOG + "记录失败:", e);
      new import_obsidian.Notice(LOG + "记录失败：" + (e && e.message ? e.message : e));
    }
  }

  /**
   * 睡前点一下记下此刻入睡（很少有人真在床边点，所以入口是次级的）。
   * 归哪一晚由 nightDateForOnset 决定：凌晨点的那一记算前一晚，
   * 不再是"点的时候日历翻到哪天就记哪天"。
   */
  async recordOnset() {
    const now = new Date();
    const onset = nowTimeStr();
    const date = nightDateForOnset(onset, now);
    const today = formatDate(now);
    try {
      const records = await this.manager.loadRange(formatDate(addDays(now, -2)), date);
      if (this.manager.hasOnsetForDate(records, date)) {
        new import_obsidian.Notice(LOG + (date === today ? "今晚的入睡已经记过了" : "昨晚的入睡已经记过了"));
        return;
      }
      // 已经记全的那一晚（有入睡也有起床）再点一次，会挂出一条把整晚顶掉的待起床；
      // 分段睡眠没有建模（2026-10-20 已定），这里直接拦住，让他去补记里改
      const complete = records.find((r) => isSleepType(r.type) && r.date === date && r.wake && !r.unregistered);
      if (complete) {
        new import_obsidian.Notice(LOG + `这一晚已经记全了（${complete.onset} → ${complete.wake}），要补请用补记`);
        return;
      }
      const record = { date, type: T_SLEEP, onset, wake: "" };
      await this.manager.addRecord(record);
      this._lastWrite = { date, srcText: formatRecordLine(record), type: T_SLEEP };
      new import_obsidian.Notice(date === today ? `入睡 ${onset}` : `记在 ${formatDateLabel(date)} 那一晚：入睡 ${onset}`);
      this.refreshAllViews();
    } catch (e) {
      console.error(LOG + "记录入睡失败:", e);
      new import_obsidian.Notice(LOG + "记录失败：" + (e && e.message ? e.message : e));
    }
  }

  async recordWake() {
    const today = formatDate(new Date());
    try {
      const pending = await this.manager.findPendingSleep(today);
      if (!pending) {
        // 有一条过了时限的"只有入睡"：先修它。再开一晚只会又写出一条孤零零的入睡
        const stale = await this.manager.findStalePending(today);
        if (stale) {
          new import_obsidian.Notice(LOG + "这一晚的起床一直没记，先把这一条补上");
          new RecordEditModal(this.app, this, { existing: stale }).open();
          return;
        }
        // 没记入睡就点起床：等于"记昨晚的睡眠"，不替他猜入睡时刻
        void this.openSleepMakeup();
        return;
      }
      const time = nowTimeStr();
      if (time === pending.onset) {
        // 同一分钟内点完入睡又点起床，算出来会是 24 小时。上一版先写后提示，
        // 等于"警告归警告，假数据已经落盘"；现在一个字都不写，直接打开那一条让人改时刻
        new import_obsidian.Notice(LOG + "入睡与起床同为 " + time + "，先把入睡时刻改一下");
        new RecordEditModal(this.app, this, { existing: pending }).open();
        return;
      }
      await this.manager.updateRecord(pending, { type: T_SLEEP, onset: pending.onset, wake: time });
      new import_obsidian.Notice(`起床 ${time}`);
      this.refreshAllViews();
    } catch (e) {
      console.error(LOG + "记录起床失败:", e);
      new import_obsidian.Notice(LOG + "记录失败：" + (e && e.message ? e.message : e));
    }
  }

  async removeRecord(record) {
    try {
      await this.manager.removeRecord(record);
      new import_obsidian.Notice("已删除");
      this.refreshAllViews();
    } catch (e) {
      console.error(LOG + "删除失败:", e);
      new import_obsidian.Notice(LOG + (e && e.message ? e.message : "删除失败"));
      this.refreshAllViews();
    }
  }

  /** 撤销只针对本插件刚写进去的那一条：按原文重定位，文件被外部改过就放弃而不是乱删 */
  async undoLast() {
    const last = this._lastWrite;
    if (!last) {
      new import_obsidian.Notice(LOG + "没有可撤销的记录");
      return;
    }
    try {
      const records = await this.manager.loadRange(last.date, last.date);
      const match = records.find((r) => r.srcText === last.srcText);
      if (!match) throw new Error("该记录已被修改或删除");
      await this.manager.removeRecord(match);
      this._lastWrite = null;
      new import_obsidian.Notice("已撤销");
      this.refreshAllViews();
    } catch (e) {
      console.error(LOG + "撤销失败:", e);
      new import_obsidian.Notice(LOG + (e && e.message ? e.message : "撤销失败"));
      this._lastWrite = null;
    }
  }

  openManual() {
    new RecordEditModal(this.app, this, { date: formatDate(new Date()) }).open();
  }

  /** 上一晚（最近一条记全的睡眠）的入睡时刻，用来给早上补记做建议值 */
  async suggestOnset() {
    try {
      const now = new Date();
      const records = await this.manager.loadRange(formatDate(addDays(now, -10)), formatDate(addDays(now, -1)));
      const done = records.filter((r) => isSleepType(r.type) && r.wake);
      if (!done.length) return "";
      done.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.onset < b.onset ? -1 : 1));
      return done[done.length - 1].onset;
    } catch (e) {
      return "";
    }
  }

  /**
   * 醒来一次记完昨晚：日期默认落在昨天，起床取现在，
   * 入睡照上一晚填一个建议值（弹窗里注明"是照上一晚填的"），不准就在里面改。
   */
  async openSleepMakeup() {
    const onset = await this.suggestOnset();
    new RecordEditModal(this.app, this, {
      type: T_SLEEP,
      date: formatDate(addDays(new Date(), -1)),
      wake: nowTimeStr(),
      onset
    }).open();
  }

  async openCurrentFile() {
    try {
      const path = await this.manager.resolveWritePath(formatDate(new Date()));
      const { file } = await this.manager.ensureFile(path, `# 健康记录\n`);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      console.error(LOG + "打开记录文件失败:", e);
      new import_obsidian.Notice(LOG + "打开记录文件失败：" + (e && e.message ? e.message : e));
    }
  }
};
