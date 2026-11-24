# 更新日志 / Changelog

完整说明见 README「版本记录」，这里只列每版要点。

## 0.9.0（2026-11-25）

界面与记录文件支持三种语言。中文用户的界面和文件写法都没有变化。

- 界面跟随 Obsidian 语言设置显示简体中文、繁體中文或 English，不用另外设置；其它语言的 Obsidian 显示英文
- 记录文件三种语言的写法都能读；新文件按界面语言写，往老文件里追加时沿用那份文件原来的语言，同一份文件不混排
- 切换语言后，本月已有的记录文件会继续写下去，不会另起一份同月文件；自己改过的目录和文件名不受影响
- 新装插件时，默认目录按界面语言取名；已经在用的不变

**English** — The interface now follows Obsidian's language (Simplified Chinese, Traditional Chinese or English; anything else falls back to English) with no extra setting. Record files written in any of the three languages are read; new files use the interface language, and additions to an existing file keep that file's language. Switching languages never renames or splits existing files.

## 0.8.3（2026-11-17）

- 修复属性区（frontmatter）被自动补的标题顶到正文的问题
- `~~~` 等围栏里的示例内容不再被当成记录
- 启用内置类型后，对应的快记命令立即出现，无需重启

## 0.8.2（2026-11-08）

- 设置页改用原生 `SettingGroup`，最低版本 1.11.0
- 新增 44 项回归测试；外部改动不再被自写回声吞掉
