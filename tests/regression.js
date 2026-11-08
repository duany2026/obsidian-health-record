/*
 * 健康记录插件的 Node 回归测试（随仓库保存，不进入 Release 资产）。
 * 运行：node tests/regression.js
 *
 * main.js 是带 CommonJS 兼容层的单文件源码，顶层函数与 var 都在模块作用域里。
 * 这里用 vm 沙箱把它当作脚本加载，桩掉 obsidian，直接取顶层纯函数与类原型，
 * 因此不需要为了测试往发布产物里加任何导出。
 */
"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "main.js");
const source = fs.readFileSync(SRC, "utf8");

class Base {}
class TFile extends Base {}
class TFolder extends Base {}
const notices = [];
const obsidian = {
  Plugin: Base,
  PluginSettingTab: Base,
  ItemView: Base,
  Modal: Base,
  Setting: Base,
  SettingGroup: null,
  Notice: class { constructor(message) { notices.push(message); } },
  TFile,
  TFolder,
  normalizePath: (p) => p,
  setIcon: () => {},
};

const sandbox = {
  console, Date, Math, Intl, JSON,
  module: { exports: {} },
  exports: {},
  require: () => obsidian,
  window: { setTimeout, clearTimeout, setInterval, clearInterval },
  document: {},
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "main.js" });

const NAMES = [
  "pad2", "formatDate", "monthIdOfDate", "nowTimeStr", "parseTimeText",
  "normalizeTimeText", "timeToMinutes", "snapMinute", "normalizeDateText",
  "dateFromStr", "addDays", "startOfWeek", "startOfMonth", "daysInMonth",
  "sleepDuration", "pendingAgeHours", "nightPosition", "nightDateForOnset",
  "sleepBarGeometry", "formatDuration", "minutesToClock", "formatMonthLabel",
  "formatDateLabel", "matchDayHeader", "isKnownType", "sanitizeNote",
  "formatRecordLine", "parseRecordLine", "parseUnregisteredLine", "fenceMask",
  "parseRecords", "findSections", "findSection", "recordSortKey", "lineSortKey",
  "withLegend", "fileIntro", "dayHeaderLine", "sectionTail",
  "applyRecordInsert", "lineIdentity", "locateRecord", "applyRecordRemove",
  "applyRecordUpdate", "defaultTypes", "setTypes", "typeMeta", "isSleepType",
  "countTypes", "sanitizeTypeName", "settingsSection", "DEFAULT_SETTINGS",
  "FILE_LEGEND", "LEGEND_MARK", "RecordManager", "HealthRecordPlugin",
  "trendMetrics", "groupByDay", "countOf", "previousViewRange",
];
const T = {};
for (const name of NAMES) {
  if (typeof sandbox[name] === "undefined") {
    throw new Error("main.js 里找不到顶层符号：" + name);
  }
  T[name] = sandbox[name];
}
T.proto = sandbox.HealthRecordPlugin.prototype;
T.RecordManagerProto = sandbox.RecordManager.prototype;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push(name);
    console.error("  FAIL " + name + " -> " + (error && error.message));
  }
}

/** 临时注册自定义类型，跑完恢复默认，免得污染后续用例。 */
async function withTypes(list, fn) {
  T.setTypes(list);
  try {
    await fn();
  } finally {
    T.setTypes(T.defaultTypes());
  }
}

const LF = "\n";
const record = (type, time, note) => ({ type, time, note: note || "" });
const sleep = (onset, wake) => ({ type: "睡眠", onset, wake: wake || "" });

/** 一份含格式说明的常规文件，往返测试才能逐字相等。 */
function sampleFile(body) {
  return [
    "# 健康记录",
    "",
    "> 格式：一天一节，节标题是 `## YYYY-MM-DD 周几`；节里一行一条记录，写成 `- 类型 | 时间 | 备注`。",
    "",
    "## 2026-10-18 周日",
    "",
    ...body,
    "",
  ].join(LF);
}

(async () => {
  console.log("健康记录回归测试");

  /* ---------------- 时间与日期 ---------------- */
  await test("formatDate 用本地年月日，不走 UTC 日界", () => {
    assert.equal(T.formatDate(new Date(2026, 0, 1, 0, 30)), "2026-01-01");
    assert.equal(T.formatDate(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
    assert.equal(T.monthIdOfDate("2026-10-18"), "2026-10");
    assert.equal(T.pad2(7), "07");
  });

  await test("时刻解析与归一化挡掉非法值", () => {
    assert.equal(T.normalizeTimeText("8:05"), "08:05");
    assert.equal(T.normalizeTimeText(" 23:59 "), "23:59");
    assert.equal(T.parseTimeText("24:00"), null);
    assert.equal(T.parseTimeText("12:60"), null);
    assert.equal(T.parseTimeText("abc"), null);
    assert.equal(T.parseTimeText(null), null);
    assert.equal(T.timeToMinutes("02:30"), 150);
    assert.equal(T.timeToMinutes(""), null);
    assert.equal(T.snapMinute(47), 45);
    assert.equal(T.snapMinute(-10), 0);
    assert.equal(T.snapMinute(99), 55);
  });

  await test("日期文本归一化拒绝不存在的日期", () => {
    assert.equal(T.normalizeDateText("2026-1-5"), "2026-01-05");
    assert.equal(T.normalizeDateText("2026-02-30"), null);
    assert.equal(T.normalizeDateText("2026-13-01"), null);
    assert.equal(T.normalizeDateText("2026/01/05"), null);
    assert.equal(T.normalizeDateText(null), null);
    assert.equal(T.matchDayHeader("## 2026-10-5 周一"), "2026-10-05");
    assert.equal(T.matchDayHeader("## 小结"), null);
    assert.equal(T.matchDayHeader("### 2026-10-05"), null);
  });

  await test("addDays 跨月跨年、startOfWeek 落在周一", () => {
    assert.equal(T.formatDate(T.addDays(new Date(2026, 11, 31), 1)), "2027-01-01");
    assert.equal(T.formatDate(T.addDays(new Date(2026, 2, 1), -1)), "2026-02-28");
    const week = T.startOfWeek(new Date(2026, 9, 21, 15, 0));
    assert.equal(week.getDay(), 1, "周一");
    assert.equal(week.getHours(), 0, "归到当天零点");
    assert.equal(T.formatDate(T.startOfMonth(new Date(2026, 9, 18))), "2026-10-01");
    assert.equal(T.daysInMonth(2024, 1), 29, "闰年二月");
    assert.equal(T.daysInMonth(2026, 1), 28);
  });

  await test("睡眠时长跨午夜补 24 小时，缺起床返回 null", () => {
    assert.equal(T.sleepDuration("23:40", "07:10"), 450);
    assert.equal(T.sleepDuration("01:30", "09:00"), 450);
    assert.equal(T.sleepDuration("22:00", "22:00"), 1440, "同时刻按跨夜处理");
    assert.equal(T.sleepDuration("23:40", ""), null);
    assert.equal(T.sleepDuration("", "07:10"), null);
  });

  await test("凌晨入睡归前一晚，早上补记昨晚，最多只退一天", () => {
    const at3 = new Date(2026, 9, 19, 3, 0);
    assert.equal(T.nightDateForOnset("02:00", at3), "2026-10-18", "凌晨那觉归前一晚");
    const at7 = new Date(2026, 9, 19, 7, 0);
    assert.equal(T.nightDateForOnset("23:40", at7), "2026-10-18", "早上填昨晚 23:40");
    assert.equal(T.nightDateForOnset("01:00", new Date(2026, 9, 19, 0, 30)), "2026-10-18", "不退成前天");
    assert.equal(T.nightDateForOnset("14:00", new Date(2026, 9, 19, 15, 0)), "2026-10-19");
    assert.equal(T.nightDateForOnset("bad", at7), "2026-10-19");
  });

  await test("夜晚轴与时长格式化", () => {
    assert.equal(T.nightPosition(18 * 60), 0);
    assert.equal(T.nightPosition(2 * 60), 480);
    assert.deepEqual(T.sleepBarGeometry("23:40", "07:10"), { start: 340, length: 450, pending: false });
    assert.equal(T.sleepBarGeometry("23:40", "").pending, true);
    assert.equal(T.formatDuration(450), "7小时30分");
    assert.equal(T.formatDuration(60), "1小时");
    assert.equal(T.formatDuration(25), "25分");
    assert.equal(T.formatDuration(null), "—");
    assert.equal(T.minutesToClock(1500), "01:00");
    assert.equal(T.formatMonthLabel("2026-10"), "2026年10月");
    assert.equal(T.formatDateLabel("2026-10-18"), "10月18日");
  });

  /* ---------------- 记录行模型 ---------------- */
  await test("记录行格式化：睡眠第三列是起床，普通类型是备注", () => {
    assert.equal(T.formatRecordLine(sleep("23:40", "07:10")), "- 睡眠 | 23:40 | 07:10");
    assert.equal(T.formatRecordLine(sleep("23:40")), "- 睡眠 | 23:40 |");
    assert.equal(T.formatRecordLine(record("水", "08:20")), "- 水 | 08:20");
    assert.equal(T.formatRecordLine(record("午餐", "12:30", "食堂")), "- 午餐 | 12:30 | 食堂");
  });

  await test("备注里的竖线转全角，避免写成四列后记录消失", () => {
    assert.equal(T.sanitizeNote("可乐|薯片"), "可乐｜薯片");
    assert.equal(T.sanitizeNote("   spaced  "), "spaced");
    assert.equal(T.formatRecordLine(record("水", "08:20", "可乐|薯片")), "- 水 | 08:20 | 可乐｜薯片");
  });

  await test("单行解析只认注册表内的类型与合法时刻", () => {
    assert.deepEqual(T.parseRecordLine("- 水 | 8:20"), { type: "水", time: "08:20", note: "" });
    assert.deepEqual(T.parseRecordLine("- 睡眠 | 23:40 |"), { type: "睡眠", onset: "23:40", wake: "" });
    assert.deepEqual(T.parseRecordLine("- 睡眠 | 23:40 | 07:10"), { type: "睡眠", onset: "23:40", wake: "07:10" });
    assert.equal(T.parseRecordLine("- 水 | 08:20 | 备注 | 多余"), null, "四列当用户内容");
    assert.equal(T.parseRecordLine("- 奶茶 | 16:40"), null, "未注册类型");
    assert.equal(T.parseRecordLine("  - 水 | 08:20"), null, "缩进不当记录");
    assert.equal(T.parseRecordLine("- 水 | 99:99"), null);
  });

  await test("未注册行单独认出来，原样显示但不计入统计", () => {
    assert.deepEqual(T.parseUnregisteredLine("- 奶茶 | 16:40 | 珍珠"),
      { type: "奶茶", time: "16:40", note: "珍珠" });
    assert.equal(T.parseUnregisteredLine("- 备注：记得复查"), null);
    assert.equal(T.parseUnregisteredLine("- 奶茶 | xx"), null);
  });

  await test("setTypes 注入自定义类型，睡眠永远在且是唯一双时刻类型", async () => {
    await withTypes([{ name: "睡眠" }, { name: "水" }, { name: "用药" }], () => {
      assert.equal(T.isKnownType("用药"), true);
      assert.equal(T.isSleepType("睡眠"), true);
      assert.equal(T.isSleepType("用药"), false);
      assert.equal(T.typeMeta("用药").group, "count");
      assert.deepEqual(Array.from(T.countTypes()), ["水", "用药"]);
      assert.ok(T.parseRecordLine("- 用药 | 09:00"));
      assert.equal(T.parseRecordLine("- 早餐 | 09:00"), null, "没登记的不认");
    });
    assert.equal(T.isKnownType("用药"), false, "测试后恢复默认表");
  });

  await test("类型名清洗：竖线、空白、长度", () => {
    assert.equal(T.sanitizeTypeName(" 用|药\n "), "用药");
    assert.equal(T.sanitizeTypeName("一二三四五六七八九十"), "一二三四五六七八");
    assert.equal(T.sanitizeTypeName(""), "");
    assert.equal(T.lineIdentity("- 水 | 8:20"), "- 水 | 08:20", "与 occurrence 用同一套身份");
    assert.equal(T.lineIdentity("- 随便写一句"), null);
  });

  /* ---------------- 文件解析 ---------------- */
  await test("parseRecords 解析日期分区、来源行号与重复序号", () => {
    const content = sampleFile([
      "- 水 | 08:20",
      "- 水 | 08:20",
      "- 睡眠 | 23:40 | 07:10",
    ]);
    const rows = T.parseRecords(content, "2026年健康记录.md");
    assert.equal(rows.length, 3);
    assert.equal(rows[0].date, "2026-10-18");
    assert.equal(rows[0].filePath, "2026年健康记录.md");
    assert.equal(rows[0].occurrence, 1);
    assert.equal(rows[1].occurrence, 2, "同日同内容按序号区分");
    assert.equal(rows[2].wake, "07:10");
    assert.ok(rows.every((r) => r.srcLine > 0));
    const day = T.groupByDay(rows).get("2026-10-18");
    assert.equal(day.total, 2, "睡眠不重复计入条数");
    assert.equal(day.sleeps.length, 1);
    assert.equal(T.countOf(day, "水"), 2);
  });

  await test("围栏里的示例行不算记录，围栏本身也不算", () => {
    const content = [
      "# 健康记录", "", "```markdown", "## 2026-10-05 周一", "- 水 | 08:00", "```", "",
      "## 2026-10-18 周日", "", "- 水 | 09:00", "",
    ].join(LF);
    const rows = T.parseRecords(content, "x.md");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].time, "09:00");
    const mask = T.fenceMask(content.split(LF));
    assert.equal(mask[3], true);
    assert.equal(mask[4], true);
    assert.equal(mask[7], false);
    const open = T.fenceMask(["```", "## 2026-10-18 周日", "- 水 | 09:00"]);
    assert.deepEqual(Array.from(open), [true, true, true], "未闭合围栏之后仍算围栏内");
  });

  await test("H1 与任意二级标题都收口，别把用户清单算成上一天", () => {
    const content = [
      "## 2026-10-18 周日", "- 水 | 08:00", "## 小结", "- 事项 | 12:30",
      "# 月度小结", "- 事项 | 13:00", "## 2026-10-19 周一", "- 水 | 09:00", "",
    ].join(LF);
    const rows = T.parseRecords(content, "x.md");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.date), ["2026-10-18", "2026-10-19"]);
  });

  await test("未注册行进明细但标 unregistered，认不出的行完全不进", () => {
    const content = sampleFile([
      "- 水 | 08:20",
      "- 奶茶 | 16:40 | 珍珠",
      "- 备注：记得复查血压",
      "- 水 | 08:20 | 备注 | 多余",
      "> 今天状态一般。",
    ]);
    const rows = T.parseRecords(content, "x.md");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].type, "奶茶");
    assert.equal(rows[1].unregistered, true);
    assert.equal(rows[0].unregistered, false);
  });

  await test("findSections 找全重复日期分区，写入用最后一节", () => {
    const lines = [
      "## 2026-10-18 周日", "- 水 | 08:00", "", "## 2026-10-18 周日", "- 水 | 09:00", "",
    ];
    const all = T.findSections(lines, "2026-10-18", T.fenceMask(lines));
    assert.equal(all.length, 2);
    assert.equal(T.findSection(lines, "2026-10-18", T.fenceMask(lines)).headerIdx, 3);
    assert.equal(T.dayHeaderLine("2026-10-18"), "## 2026-10-18 周日");
  });

  /* ---------------- 写入纯函数：用户内容不得被改写 ---------------- */
  await test("fileIntro 只写一次格式说明，withLegend 幂等", () => {
    const intro = T.fileIntro();
    assert.ok(intro.startsWith("# 健康记录"));
    assert.equal((intro.match(/格式：一天一节/g) || []).length, 1);
    const lines = intro.split(LF);
    assert.equal(T.withLegend(lines).length, lines.length, "已有说明不再插第二遍");
    assert.equal(T.withLegend(["# 健康记录"]).filter((l) => l.includes(T.LEGEND_MARK)).length, 1);
  });

  await test("格式说明不会被插进围栏里的示例", () => {
    const lines = ["# 健康记录", "", "```", "## 2026-10-05", "- 水 | 08:00", "```", "", "## 2026-10-18 周日", "- 水 | 09:00"];
    const out = T.withLegend(lines);
    const legend = out.findIndex((l) => l.includes(T.LEGEND_MARK));
    const fence = out.findIndex((l) => l.trim() === "```");
    assert.ok(legend >= 0 && legend < fence, "说明在围栏之前");
    assert.equal(out.filter((l) => l.includes(T.LEGEND_MARK)).length, 1);
  });

  await test("插入：已有分区内按时刻排序，不是追加到末尾", () => {
    const content = sampleFile(["- 水 | 08:00", "- 水 | 10:00"]);
    const out = T.applyRecordInsert(content, "2026-10-18", record("水", "09:00"), LF);
    const lines = out.split(LF);
    const at = (text) => lines.indexOf(text);
    assert.ok(at("- 水 | 09:00") > at("- 水 | 08:00"));
    assert.ok(at("- 水 | 09:00") < at("- 水 | 10:00"));
  });

  await test("插入：新建日期分区按日期升序放，不追加到文件末尾", () => {
    const content = [
      "# 健康记录", "", "> 格式：一天一节", "",
      "## 2026-10-20 周二", "", "- 水 | 08:00", "",
      "## 2026-10-25 周日", "", "- 水 | 08:00", "",
    ].join(LF);
    const out = T.applyRecordInsert(content, "2026-10-22", record("水", "09:00"), LF);
    const headers = out.split(LF).filter((l) => l.startsWith("## ")).map((l) => l.slice(3, 13));
    assert.deepEqual(headers, ["2026-10-20", "2026-10-22", "2026-10-25"]);
    assert.ok(out.includes("- 水 | 09:00"));
  });

  await test("插入：用户写在记录下面的引用块位置一动不动", () => {
    const content = sampleFile(["- 水 | 08:20", "", "> 今天状态一般，午饭后有点困。"]);
    const out = T.applyRecordInsert(content, "2026-10-18", record("水", "09:30"), LF);
    const lines = out.split(LF);
    const prose = lines.indexOf("> 今天状态一般，午饭后有点困。");
    const inserted = lines.indexOf("- 水 | 09:30");
    assert.ok(prose >= 0, "引用块还在");
    assert.ok(inserted > prose, "新记录排在用户那段话之后");
    assert.ok(lines.indexOf("- 水 | 08:20") < prose, "原记录仍在引用块之上");
    assert.equal(T.parseRecords(out, "x.md").length, 2);
  });

  await test("插入：补记更早的时刻不越过用户正文（已知边界）", () => {
    const content = sampleFile(["- 水 | 10:00", "", "> 补一句"]);
    const out = T.applyRecordInsert(content, "2026-10-18", record("水", "07:00"), LF);
    const lines = out.split(LF);
    assert.ok(lines.indexOf("- 水 | 07:00") > lines.indexOf("> 补一句"));
    assert.equal(T.parseRecords(out, "x.md").length, 2, "界面上仍是两条");
  });

  await test("插入：CRLF 文件按自身换行风格回写", () => {
    const out = T.applyRecordInsert(sampleFile(["- 水 | 08:00"]), "2026-10-18", record("水", "09:00"), "\r\n");
    assert.ok(out.includes("\r\n"));
    assert.equal(/[^\r]\n/.test(out), false, "不混用 LF");
  });

  await test("插入：文件末尾未闭合围栏先补闭合，新分区不写进围栏", () => {
    const content = ["# 健康记录", "", "> 格式：一天一节", "", "## 2026-10-18 周日", "- 水 | 08:00", "```"].join(LF);
    const out = T.applyRecordInsert(content, "2026-10-19", record("水", "09:00"), LF);
    const lines = out.split(LF);
    const close = lines.indexOf("```");
    const header = lines.indexOf("## 2026-10-19 周一");
    assert.ok(close >= 0 && header > close, "新分区在闭合之后");
    assert.equal(T.parseRecords(out, "x.md").filter((r) => r.date === "2026-10-19").length, 1);
  });

  await test("删除：按 occurrence 精确删掉重复行中的第二条", () => {
    const content = sampleFile(["- 水 | 08:20", "- 水 | 08:20"]);
    const target = Object.assign({ date: "2026-10-18", occurrence: 2 }, record("水", "08:20"));
    const out = T.applyRecordRemove(content, target, LF);
    assert.equal((out.match(/- 水 \| 08:20/g) || []).length, 1);
    assert.ok(out.includes("> 格式：一天一节"), "说明没被删掉");
  });

  await test("删除：目标不存在时抛错，不静默改写文件", () => {
    const content = sampleFile(["- 水 | 08:20"]);
    assert.throws(() => T.applyRecordRemove(content,
      Object.assign({ date: "2026-10-18", occurrence: 1 }, record("水", "09:00")), LF),
      /记录已被修改或不存在/);
  });

  await test("修改：只替换目标行，其它行与用户正文原样保留", () => {
    const content = sampleFile(["- 水 | 08:20", "- 备注：记得复查", "- 水 | 09:00"]);
    const target = Object.assign({ date: "2026-10-18", occurrence: 1 }, record("水", "08:20"));
    const out = T.applyRecordUpdate(content, target, record("水", "08:35", "温水"), LF);
    assert.ok(out.includes("- 水 | 08:35 | 温水"));
    assert.ok(!out.includes("- 水 | 08:20\n"));
    assert.ok(out.includes("- 备注：记得复查"));
    assert.ok(out.includes("- 水 | 09:00"));
  });

  await test("删除不会动围栏里的示例行", () => {
    const content = [
      "# 健康记录", "", "> 格式：一天一节", "", "```", "- 水 | 08:20", "```", "",
      "## 2026-10-18 周日", "", "- 水 | 08:20", "",
    ].join(LF);
    const target = Object.assign({ date: "2026-10-18", occurrence: 1 }, record("水", "08:20"));
    const out = T.applyRecordRemove(content, target, LF);
    assert.ok(out.includes("```\n- 水 | 08:20\n```"), "围栏里的示例还在");
    assert.equal(T.parseRecords(out, "x.md").length, 0);
  });

  await test("端到端往返：插入→解析→删除后文件逐字回到原状", () => {
    const original = sampleFile(["- 水 | 08:20", "", "> 今天状态一般。", ""]);
    const added = T.applyRecordInsert(original, "2026-10-18", record("水", "09:30"), LF);
    const rows = T.parseRecords(added, "x.md");
    assert.equal(rows.length, 2);
    const fresh = rows.find((r) => r.time === "09:30");
    const back = T.applyRecordRemove(added, fresh, LF);
    assert.equal(back, original, "不丢用户正文、不多空行");
  });

  /* ---------------- 管理器：文件识别与缓存 ---------------- */
  await test("归档文件名按月/按年生成", () => {
    const mgr = new T.RecordManager({}, { archivePeriod: "month", storageFolder: "健康记录" });
    assert.equal(mgr.recordFileName("2026-10-18"), "2026-10月健康记录.md");
    mgr.settings.archivePeriod = "year";
    assert.equal(mgr.recordFileName("2026-10-18"), "2026年健康记录.md");
    assert.equal(mgr.buildPath("2026年健康记录.md"), "健康记录/2026年健康记录.md");
  });

  await test("文件名识别：认年份开头，挡掉同步盘冲突副本", () => {
    const mgr = new T.RecordManager({}, { archivePeriod: "year", storageFolder: "健康记录" });
    for (const name of ["2026年健康记录.md", "2026-10月健康记录.md", "2026-10.md", "2026-10-备份.md"]) {
      assert.equal(mgr.looksLikeRecordName(name), true, name);
    }
    for (const name of ["2026-10月健康记录 1.md", "二园人员变动.md", "健康记录.txt", "readme.md"]) {
      assert.equal(mgr.looksLikeRecordName(name), false, name);
    }
  });

  await test("内容识别要求日期分区与记录行同时存在", async () => {
    let content = "";
    const mgr = new T.RecordManager({ vault: { cachedRead: async () => content } }, {});
    content = "## 2026-10-18 周日\n\n- 水 | 08:20\n";
    assert.equal(await mgr.looksLikeRecordFile({}), true);
    content = "## 2026-10-18 周日\n\n今天状态一般。\n";
    assert.equal(await mgr.looksLikeRecordFile({}), false, "只有分区不算");
    content = "- 水 | 08:20\n";
    assert.equal(await mgr.looksLikeRecordFile({}), false, "只有记录行不算");
  });

  await test("读缓存 5 秒内不重复读盘，dropFileCache 立即失效", async () => {
    let reads = 0;
    const app = {
      vault: {
        getAbstractFileByPath: () => new TFile(),
        cachedRead: async () => { reads++; return "## 2026-10-18 周日\n- 水 | 08:20\n"; },
      },
    };
    const mgr = new T.RecordManager(app, { archivePeriod: "year" });
    const first = await mgr.loadFile("x.md");
    await mgr.loadFile("x.md");
    assert.equal(reads, 1, "命中缓存");
    assert.equal(first.length, 1);
    mgr.dropFileCache("x.md");
    await mgr.loadFile("x.md");
    assert.equal(reads, 2, "失效后重读");
    assert.equal(mgr.readCache.has("x.md"), true);
  });

  await test("loadRange 按日期过滤，跨文件同一行只算一次", async () => {
    const content = "## 2026-10-18 周日\n- 水 | 08:20\n";
    const app = { vault: { getAbstractFileByPath: () => new TFile(), cachedRead: async () => content } };
    const mgr = new T.RecordManager(app, { archivePeriod: "year" });
    mgr.recordFiles = async () => ["a.md", "b.md", "c.md"];
    const rows = await mgr.loadRange("2026-10-18", "2026-10-18");
    assert.equal(rows.length, 1, "三份副本去重成一条");
    assert.equal((await mgr.loadRange("2026-10-20", "2026-10-21")).length, 0, "窗口外的不算");
  });

  await test("存储目录清洗挡住 .. 与多余斜杠", () => {
    const fake = Object.create(T.proto);
    assert.equal(fake.sanitizeFolder(" 笔记\\任务\\ "), "笔记/任务");
    assert.equal(fake.sanitizeFolder("../笔记"), "");
    assert.equal(fake.sanitizeFolder("笔记/../任务"), "");
    assert.equal(fake.sanitizeFolder(""), "");
  });

  /* ---------------- 设置迁移 ---------------- */
  async function loadWith(saved) {
    const fake = Object.create(T.proto);
    fake.loadData = async () => saved;
    await T.proto.loadSettings.call(fake);
    return fake.settings;
  }

  await test("设置迁移：lastTab 为空时接纳旧 defaultTab，旧键删除", async () => {
    const s = await loadWith({ lastTab: "", defaultTab: "week" });
    assert.equal(s.lastTab, "week");
    assert.equal("defaultTab" in s, false);
    assert.equal((await loadWith({ lastTab: "nonsense" })).lastTab, "today");
  });

  await test("设置迁移：非法枚举回落，types 为空补默认", async () => {
    const s = await loadWith({ archivePeriod: "weekly", rangeMode: "bad", types: [], trendMetric: "不存在" });
    assert.equal(s.archivePeriod, "month");
    assert.equal(s.rangeMode, "rolling");
    assert.equal(s.trendMetric, "sleep");
    assert.equal(s.types[0].name, "睡眠");
    assert.equal(T.isSleepType("睡眠"), true, "setTypes 已按新清单重建");
  });

  await test("设置迁移：缺睡眠自动补回，类型去重且上限 16", async () => {
    const s = await loadWith({ types: [{ name: "用药" }, { name: "用药" }] });
    assert.equal(s.types[0].name, "睡眠");
    assert.equal(s.types.filter((t) => t.name === "用药").length, 1);
    const many = await loadWith({ types: Array.from({ length: 30 }, (_, i) => ({ name: "T" + i })) });
    assert.equal(many.types.length, 16, "含睡眠共 16 项");
    assert.equal(many.types[0].name, "睡眠");
  });

  /* ---------------- 外部改动可见性（一次性自写回声） ---------------- */
  function fakePlugin() {
    const dropped = [];
    const refreshed = [];
    const fake = Object.create(T.proto);
    fake.settings = { storageFolder: "健康记录" };
    fake.manager = {
      dropFileCache: (p) => dropped.push(p),
      filesCache: { at: 1, list: ["stale"] },
      looksLikeRecordName: () => true,
    };
    fake.isOurFile = () => true;
    fake.repaintSettings = null;
    fake.scheduleRefresh = (delay) => refreshed.push(delay);
    return { fake, dropped, refreshed, file: new TFile() };
  }

  await test("自写回声：缓存仍失效，但跳过一次重复刷新", () => {
    const ctx = fakePlugin();
    ctx.file.path = "健康记录/2026年健康记录.md";
    ctx.fake._pendingSelfWrite = ctx.file.path;
    ctx.fake.handleFileChange(ctx.file, false);
    assert.deepEqual(ctx.dropped, [ctx.file.path], "自写也要失效缓存");
    assert.deepEqual(ctx.refreshed, [], "调用处已刷新，不再排队");
    assert.equal(ctx.fake._pendingSelfWrite, null, "标记一次性消费");
  });

  await test("外部 modify：缓存失效并排队刷新", () => {
    const ctx = fakePlugin();
    ctx.file.path = "健康记录/2026年健康记录.md";
    ctx.fake.handleFileChange(ctx.file, false);
    assert.deepEqual(ctx.dropped, [ctx.file.path]);
    assert.deepEqual(ctx.refreshed, [300]);
  });

  await test("自写之后紧接的外部改动不会再被时间窗吞掉", () => {
    const ctx = fakePlugin();
    ctx.file.path = "健康记录/2026年健康记录.md";
    ctx.fake._pendingSelfWrite = ctx.file.path;
    ctx.fake.handleFileChange(ctx.file, false); // 自写回声
    ctx.fake.handleFileChange(ctx.file, false); // 同步盘落地
    assert.equal(ctx.dropped.length, 2, "两次都失效缓存");
    assert.deepEqual(ctx.refreshed, [300], "外部改动触发刷新");
  });

  await test("自写标记在不同路径上不生效；create/delete 一律刷新", () => {
    const a = fakePlugin();
    a.file.path = "健康记录/2026年健康记录.md";
    a.fake._pendingSelfWrite = "健康记录/别的.md";
    a.fake.handleFileChange(a.file, false);
    assert.deepEqual(a.refreshed, [300], "路径不匹配照常刷新");

    const b = fakePlugin();
    b.file.path = "健康记录/2026年健康记录.md";
    b.fake._pendingSelfWrite = b.file.path;
    b.fake.handleFileChange(b.file, true);
    assert.equal(b.fake.manager.filesCache, null, "文件清单缓存清空");
    assert.deepEqual(b.refreshed, [300], "create/delete 不吃回声标记");
  });

  console.log("通过 " + passed + " 项，失败 " + failures.length + " 项");
  if (failures.length) process.exitCode = 1;
})();
