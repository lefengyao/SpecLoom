# SpecLoom 用量统计设计

- 状态：已确认，等待实现
- 日期：2026-10-22
- 范围：模型请求用量记录、全局统计页面、项目筛选
- 不包含：费用估算、写作统计、按小时分布、导出、历史逐次回填

## 1. 目标

### 1.1 记录

每次模型请求成功完成后，记录：

- 时间
- 项目路径
- session ID
- provider ID / provider 名称
- 模型
- 输入 token
- 输出 token
- 缓存命中 token
- 缓存写入 token
- run ID、call ID
- 用量来源

记录失败不能影响聊天完成。

### 1.2 展示

新增“用量”页面：

- 全局统计，可筛选项目
- 总调用次数
- 总输入 token
- 总输出 token
- 缓存命中率
- 最近 14 天趋势
- 按模型汇总
- 最近调用列表
- 刷新
- 空状态

### 1.3 数据可靠性

- 追加写入 `<userData>/usage.jsonl`
- 写入串行化
- 单条损坏只跳过该条
- 最多保留 20,000 条或 16 MiB
- 超出后裁剪最旧记录

## 2. 非目标

- 不做费用/价格估算
- 不做写作字数统计
- 不做按小时分布
- 不做 CSV、图片或 PDF 导出
- 不回填历史会话的逐次请求
- 不把历史会话总量当作精确小时数据
- 不记录失败、取消或未产生用量的请求

## 3. 数据模型

复用 `UsageRecord`，新增可选字段：

```ts
sessionId?: string
```

最终记录示例：

```json
{
  "at": 1792650000000,
  "workspaceId": "E:\\project",
  "sessionId": "session-123",
  "providerId": "deepseek",
  "providerName": "DeepSeek",
  "model": "deepseek-chat",
  "promptTokens": 1024,
  "completionTokens": 256,
  "cachedTokens": 128,
  "cacheWriteTokens": 0,
  "runId": "run-123",
  "callId": "call-123",
  "purpose": "basic",
  "status": "completed",
  "usageSource": "actual"
}
```

规则：

- `providerName` 第一版允许等于 `providerId`
- 只有实际返回的 usage 才记录
- 没有 usage 的模型请求不写入
- 时间使用 `Date.now()`

## 4. 存储

新增 `src/main/core/usage-store.ts`：

```ts
class UsageStore {
  constructor(root: string)
  append(record: UsageRecord): Promise<void>
  list(): Promise<UsageRecord[]>
}
```

- 文件：`<userData>/usage.jsonl`
- 每行一个 JSON
- 写入队列串行执行
- `list()` 跳过无法解析或校验失败的行
- 超过 20,000 条或 16 MiB 时重写为最近 20,000 条
- 不使用数据库，不引入新依赖

## 5. 记录接入

`SessionRuns` 增加可选回调：

```ts
onUsageRecord?: (record: UsageRecord) => void
```

在每次 `onUsage` 成功后调用，参数来自：

- 当前 session 的 `model.providerId` / `model.model`
- 当前项目路径
- 当前 run ID / call ID
- usage 中的 token 数

`DesktopSessions` 把回调接到 `UsageStore.append`，并吞掉写入错误，只写诊断日志。

不得把记录写入放在聊天完成的阻塞路径上；使用 `void append(...).catch(...)`。

## 6. API

`DesktopApi` 增加：

```ts
usage?: {
  list(): Promise<UsageRecord[]>
}
```

IPC 操作：

- `usageList`：无参数，返回最近记录

preload 增加 `usage.list`。

## 7. 页面

新增 `src/renderer/UsageView.tsx`，导航 id `usage`，放在“工具”组。

布局：

1. 标题 + 项目筛选 + 刷新
2. 汇总卡片：
   - 调用次数
   - 输入 token
   - 输出 token
   - 缓存命中率
3. 最近 14 天趋势
   - 无依赖的 CSS/SVG 柱状图
   - 每天显示调用次数和 token 数
4. 模型表：
   - provider
   - model
   - calls
   - input
   - output
   - cache hit
5. 最近调用：
   - 时间
   - 项目名
   - 模型
   - token
   - 状态

空状态：没有记录时显示说明和刷新按钮。

## 8. 错误处理

- `usage.list` 失败：页面显示错误，不崩溃
- 单条记录损坏：忽略
- 写入失败：聊天继续；诊断日志记录
- 项目路径缺失：记录仍写入，项目筛选中归为“未归属”
- 页面刷新失败：保留旧数据并显示错误

## 9. 测试

### UsageStore

- append 后 list 返回记录
- 损坏行被跳过
- 超过 20,000 条裁剪
- 并发 append 不丢记录
- `sessionId` 可选

### 记录接入

- `SessionRuns` 在 onUsage 后调用 `onUsageRecord`
- 记录失败不改变 run 结果
- 没有 usage 时不调用

### UsageView

- 空状态
- 汇总数字
- 项目筛选
- 模型表
- 最近调用

### 命令

- `npm run typecheck`
- 用量定向测试
- 插件定向测试保持通过

## 10. 验收标准

1. 新模型请求产生一条 usage 记录。
2. `usage.jsonl` 追加写入，重启后仍可读取。
3. 页面默认显示全部项目，并可切换项目。
4. 汇总、趋势、模型表、最近调用与记录一致。
5. 损坏记录不会导致页面或读取失败。
6. 用量写入失败不影响聊天。
7. 类型检查和定向测试通过。
