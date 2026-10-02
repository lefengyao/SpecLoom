# Local MCP

打开桌面应用与项目，在工作区创建并确认任务，然后在 MCP 页面获取地址、会话令牌和任务 ID。地址和令牌每次启动更新；令牌仅授权本机接口，不是模型 API 密钥。

支持 Streamable HTTP 的客户端配置示例：

```json
{
  "mcpServers": {
    "specloom": {
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": {
        "Authorization": "Bearer <SESSION_TOKEN>"
      }
    }
  }
}
```

工具名称为 `files.list_versions`、`files.read`、`files.write`、`files.patch`、`bash.exec`、`skills.list`、`skills.load`、`godot.validate`、`changes.preview`、`changes.commit`。每个调用在普通参数之外包含 `taskId`。

```json
{
  "name": "files.list_versions",
  "arguments": {
    "taskId": "<APPROVED_TASK_ID>",
    "paths": ["specs/project.md", "scripts/keeper.gd"]
  }
}
```

先获取版本，再通过 `files.read` 使用 `expectedVersion` 读取文件。修改现有文件要求实际读取凭证；创建要求版本为 `absent`。局部写入参数为 `patch: { "search": "...", "replace": "..." }`，上下文必须只匹配一次。

所有写入暂存到同一个任务变更集。人工模式中的 `changes.commit` 会返回 `APPROVAL_REQUIRED`，用户在桌面预览并批准当前差异后才能提交。自动模式只能提交已通过完整验证的准确摘要。MCP 没有创建任务、扩大范围、改变模型端点或批准人工提交的工具。

调用成功返回 JSON 文本。失败包含 `isError: true` 与结构化 `code`、`message`、冲突路径等信息。`VERSION_CONFLICT` 要求重新读取、重新规划；不能重放旧文件内容来解决冲突。

服务仅监听回环地址，不接受其他网站的 Origin 或任意 Host。请求上限为 1 MiB，同时最多 8 个活动请求；不提供不受约束的主机 Shell、文件系统或凭据访问。
