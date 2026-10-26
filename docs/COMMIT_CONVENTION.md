# 提交规范（Conventional Commits 中文版）

> 本仓库所有提交遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范。
> 格式不对的提交会在 code review 时被要求重写。

---

## 1. 提交格式

```
<type>(<scope>): <subject>

[可选 body：为什么改、影响范围、副作用]

[可选 footer：BREAKING CHANGE / Closes #issue]
```

- **type**：必填，见下方类型表
- **scope**：建议填写，表示影响的模块（见下方 scope 表）
- **subject**：必填。中文或英文均可，祈使句，≤50 字，**结尾不加句号**
- **body**：可选。说明「为什么改」而不是「改了什么」（diff 已经说明改了什么）
- 一次提交只做一件事；**提交前 `npm test` 必须全绿**

## 2. type 类型表

| type | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(roaming): 无限漫游模式——队列见底自动续歌` |
| `fix` | 缺陷修复 | `fix(web): 解锁按钮 promise 挂起导致遮罩不消失` |
| `docs` | 只改文档 | `docs(persona): Valen 身份与诗意口播风格手册` |
| `style` | 代码格式（不影响逻辑） | `style(server): 统一引号风格` |
| `refactor` | 重构（不改行为） | `refactor(taste): 导入与分析逻辑抽为共享模块` |
| `perf` | 性能优化 | `perf(compute): TTS 与音乐解析并行` |
| `test` | 补测试 | `test(dj-action): R3 单引号含 it's 边界` |
| `chore` | 构建/工具/杂项 | `chore(deps): 升级 better-sqlite3` |
| `revert` | 回滚某次提交 | `revert: feat(roaming): 无限漫游模式` |

## 3. scope 模块表

| scope | 覆盖范围 |
|---|---|
| `server` | src/server.js、src/ws/、HTTP/WS 契约 |
| `brain` | src/adapters/brain/、src/layer2/brain.js、dj-action.js |
| `tts` | src/adapters/tts/、src/layer2/tts.js、字幕 |
| `music` | src/providers/music/、封面/歌词/直链 |
| `taste` | 品味画像管线（taste.js、导入/分析工具） |
| `roaming` | 无限漫游批次逻辑 |
| `context` | src/layer2/context.js、语料与 prompt 组装 |
| `web` | web/ 前端（播放器/字幕/歌词/视图） |
| `scheduler` | src/layer2/scheduler.js、planner、calendar |
| `state` | src/layer2/state.js、数据库迁移 |
| `deps` | package.json / npm 依赖 |
| `docs` | docs/ 与 README（配合 docs type） |
| `repo` | .gitignore、.gitattributes、仓库配置 |

## 4. subject 写法

- 用**结果**描述，不用过程：「修复遮罩不消失」✓，「修改 app.js」✗
- 破坏性变更：subject 后加 `!`，并在 body 里写 `BREAKING CHANGE: <说明>`
- 关联 issue：footer 写 `Closes #12`

### 真实示例（取自本项目迭代史）

```
feat(roaming): 无限漫游模式——队列见底自动按品味画像续歌
fix(web): autoplay 解锁 promise 挂起导致遮罩不消失
feat(tts): DJ 人声调频效果链（高通+低通+饱和+压缩）
feat(context): DjAction 新增 intros[]——每首歌专属口播
fix(brain): 会话轮换阈值 30K tokens 防止输入膨胀
feat(taste): 歌单导入→大脑分析→品味画像管线
docs(persona): Valen 身份与诗意口播风格手册
perf(compute): TTS 与音乐解析并行、首曲同步其余后台补齐
```

## 5. 提交前自检清单

```bash
npm test                 # 89+ 断言全绿
npm run validate:all     # 语料/配置/文档一致性
git status               # 确认没有 .env / data/ / taste-imports/ 混入
```

**密钥红线**：`config/.env`（含 AppSecret/私钥/令牌）**永远不入库**。
不小心 add 了：`git rm --cached config/.env` 后重提；已经 push 出去的密钥
**必须立刻在网易云开放平台重置 AppSecret**，换新密钥写回本地 .env。

## 6. 分支与合并

- `main`：可运行状态，每次 push 前 npm test 全绿
- 功能开发：`feat/xxx` 分支 → 自测通过 → 合回 main（本地 merge 即可）
- 提交粒度：一个功能点一个提交；大功能拆「骨架 → 功能 → 测试」多步提交
