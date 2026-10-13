# 工具接口（0.2.1）

每个成功结果同时提供 MCP `structuredContent` 和 JSON 文本。失败返回 `isError: true`，内容格式为 `{ "error": { "code": "...", "message": "..." } }`。参数格式错误由 MCP SDK 校验并返回工具错误。

## 定位文件

文件工具使用 `path`，可选 `root`。多根工作区先调用 `workspace_info`，使用根目录的 `uri` 作为 `root`。文件、目录必须位于本机工作区；不支持网络路径或 Windows Alternate Data Streams。

```json
{ "path": "src/main.ts", "root": "file:///e%3A/Project/my-app" }
```

## 查询

- `workspace_info`：无参数。返回 `instanceId`、`roots`、`trusted`、`capabilities`、`limits` 和坐标约定。
- `files_list`：`path`、可选 `root`，`offset=0`、`limit=100`（最大 500）。返回 `entries`、`total`、`nextOffset`。
- `file_read`：`path`、可选 `root`、`startLine=1`、`endLine`、`maxCharacters=65536`。返回 `text`、`truncated`、`uri`、`contentHash`、`version`、`isDirty`、`lineCount`、`languageId`。空文件有一行。返回文本不包含指定末行后的换行。
- `files_search`：`query`（单行字面文本，非正则）、`glob="**/*"`、可选 `root`、`caseSensitive=true`、`limit=50`（最大 200）。返回匹配位置与简短上下文、扫描和跳过数量、截断标识。搜索已有文件的最新文档内容，不扫描未命名文档。
- `editor_context`：无参数。返回允许访问的已加载文档元数据和当前编辑器选区；文档列表最多 200 条，不包含正文。
- `editor_open`：`path`、可选 `root`、`line=1`、`column=1`。
- `diagnostics_get`：可选 `path`、`root`，`limit=100`（最大 500）。返回当前已有诊断及严重级别、来源和位置。它不会主动等待语言服务完成分析。

## 替换或创建

```json
{
  "path": "src/main.ts",
  "text": "console.log('updated');\n",
  "expectedHash": "从 file_read 获取的 64 位 SHA-256 摘要",
  "save": false
}
```

新文件改用 `create: true`，省略 `expectedHash`。已存在文件不会被 create 覆盖。父目录必须存在。需要将正文立即落盘时传 `save: true`。

## 范围修改

`file_apply_edits` 接受一个文件上的多个范围修改，范围基于同一份原始内容，彼此不可重叠。结束坐标不包含在修改范围内。相同起止位置表示插入；相同插入点不能重复指定。

```json
{
  "path": "src/main.ts",
  "expectedHash": "从 file_read 获取的摘要",
  "edits": [
    { "start": { "line": 3, "column": 1 }, "end": { "line": 3, "column": 4 }, "text": "let" }
  ],
  "save": false
}
```

返回修改后的摘要和 `isDirty`、`saved`。最多 100 处修改，结果仍须在 1 MiB 限制内。开启 `requireApproval` 后改为返回待确认提案。

## 保存

`file_save` 参数为 `path`、可选 `root`、`expectedHash`。应使用上次修改返回的摘要；保存前再次检查内容，避免保存用户后来输入的改动。保存参与者可能改变正文；返回摘要对应保存后的编辑器内容。

## 常见错误

| 错误码 | 客户端处理 |
| --- | --- |
| `ROOT_REQUIRED` | 从 workspace_info 获取并指定根 URI |
| `PATH_DENIED` | 使用工作区内普通文件路径 |
| `HASH_REQUIRED` | 先读取文件，再提供摘要 |
| `VERSION_CONFLICT` | 重新读取并重新计算修改范围 |
| `INVALID_RANGE` / `OVERLAPPING_EDITS` | 修正坐标或拆分重叠修改 |
| `ALREADY_EXISTS` | 读取现有文件，按替换流程处理 |
| `FILE_TOO_LARGE` / `BINARY_FILE` | 使用适合该文件的其他工具 |
| `WORKSPACE_UNTRUSTED` / `WRITE_DISABLED` | 当前不允许写入，交由用户调整设置 |
| `SAVE_FAILED` | 检查编辑器状态；修改可能仍留在缓冲区 |
| `FileNotFound` / `NoPermissions` | 检查文件位置和系统权限 |

日志只记录工具名称、结果码与耗时，不记录凭据、正文或工具参数。

## 批量修改与预览

`files_write` 和 `files_preview` 接受 `files` 数组（1–20 个文件），每个元素使用 `file_write` 的 `path`、`root`、`text`、`create=false`、`expectedHash` 和 `save=false` 参数。每文件最多 1 MiB，批量正文上限 4 MiB，但 HTTP JSON 请求体仍须小于 2 MiB。重复路径或指向同一路径的符号链接别名会被拒绝。

```json
{
  "files": [
    { "path": "a.ts", "text": "updated a", "expectedHash": "读取 a.ts 得到的摘要" },
    { "path": "b.ts", "text": "updated b", "expectedHash": "读取 b.ts 得到的摘要" }
  ]
}
```

`files_write` 在检查所有文件的路径、大小、摘要和创建条件后，用一次 `WorkspaceEdit` 应用修改，返回 `{ applied: true, files: [...] }`。预校验失败时不会应用任何文件修改；包含文件创建时，不承诺磁盘层面的原子事务。保存逐文件进行，失败时已应用的修改保留，并在 `saveErrors` 中列出失败文件；客户端应检查各文件 `saved`，不能将成功响应理解为全部保存成功。

`files_preview` 不修改文件，返回 `{ proposalId, status: "pending", files }`。用户在侧边栏查看差异并接受或拒绝。接受时再次检查全部文件的摘要、路径和权限。每窗口最多 20 个未完成提案，原文与修改文本总计最多 10 MiB；最近 100 个已完成状态保留在内存中，关闭窗口后失效。

开启 `vscodeMcp.requireApproval` 时，`file_write`、`file_apply_edits`、`file_save` 和 `files_write` 均返回待确认提案；此时不会立即应用或保存。`proposal_get` 接受 `proposalId`，返回 `pending`、`applying`、`accepted`、`rejected` 或 `failed`。接受后的 `result` 含文件快照；失败的 `result.error` 含错误码。Agent 无法通过 MCP 自动接受提案。

## Git 查询

- `git_status`：可选 `root`，返回 `git status --porcelain=v1` 文本。
- `git_diff`：可选 `root`、`path`、`staged=false`。默认查看未暂存差异，`staged=true` 查看暂存差异；关闭外部差异驱动和 textconv。
- `git_log`：可选 `root`、`limit=20`（最大 100），每行包含提交摘要、作者时间、作者和标题。

多根工作区应明确指定根 URI。仓库根目录必须在工作区内；打开仓库的子目录且仓库根在工作区外时拒绝查询。返回 `text`、`truncated`、`source: "git-on-disk"`、`includesUnsavedChanges: false`。输出最多 65536 字符；底层查询超过 2 MiB 或 10 秒返回 `GIT_FAILED`。要求系统安装 Git。

## 语言服务

- `symbols_get`：`path`、可选 `root`、`limit=100`（最大 200），返回扁平化 `symbols`、`total`、`truncated`。
- `definitions_get` / `references_get`：`path`、可选 `root`、`line`、`column`、`limit=100`（最大 200），返回 `locations`、`total`、`truncated`。

只返回工作区内位置，坐标从 1 开始，列按 UTF-16 计数。依赖已安装的语言服务，空结果不保证不存在符号或引用。通过 [VS Code 内置 Provider 命令](https://code.visualstudio.com/api/references/commands) 查询。

## 任务

- `tasks_list`：无参数，返回 `enabled` 和最多 200 个任务的 `id`、`name`、`source`、`root`、`allowed` 和 `background`。
- `task_run`：`taskId` 必须来自 `tasks_list`，返回 `runId`、状态和开始时间，不等待任务结束。
- `task_status`：`runId`，返回状态、起止时间和 `exitCode`。`completed` 只表示已结束，必须检查退出码；`null` 表示未知。
- `task_stop`：`runId`，向本窗口由 MCP 启动的任务发送终止请求，随后查询状态。不会停止其他任务。

必须开启 `vscodeMcp.tasks.enabled`，在 `vscodeMcp.tasks.allowedNames` 中允许对应名称，并信任工作区。仅执行本机工作区已有任务，客户端不能附加命令或参数。同一窗口最多运行 4 个 MCP 任务，保留最近 100 个已完成运行。终端正文无法通过 VS Code 1.85 任务 API 读取，返回结果中的 `output` 指向任务终端的查看方式。插件卸载时终止仍在运行的 MCP 任务。

新增错误码：`DUPLICATE_PATH`、`BATCH_TOO_LARGE`、`REVIEW_LIMIT`、`REVIEW_NOT_FOUND`、`REVIEW_NOT_PENDING`、`GIT_FAILED`、`TASKS_DISABLED`、`TASK_NOT_ALLOWED`、`TASK_NOT_FOUND`、`TASK_LIMIT`、`TASK_ALREADY_RUNNING`。已在运行的任务不会被 MCP 接管。
