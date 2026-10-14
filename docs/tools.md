# 工具接口（0.3.0）

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
- `files_search`：新搜索提供 `query`、`regex=false`、`glob="**/*"`、可选 `root` / `exclude`、`caseSensitive=true`、`limit=50`（最大 200）。继续搜索只传 `cursor`。详细分页规则见下文。
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

## 代码理解

位置查询参数为 `path`、可选 `root`、`line`、`column`，坐标从 1 开始、列按 UTF-16 计数。可选 `limit=50`（1–200）；全部只读、不执行建议中的命令。查询最新编辑器内容，文件在查询期间变化返回 `VERSION_CONFLICT`；语言请求限 10 秒，无提供者或无结果可能为空。

- `hover_get`：返回 `hovers`（`text` / `range` / `truncated`），Markdown 按数据返回，总正文最多 65536 字符。
- `completions_get`：可选单字符 `triggerCharacter`，返回 `items`（标签、类型、说明、文档、`insertText`、`snippet`）、`isIncomplete` / `truncated`。不执行补全命令或应用其编辑；未解析建议可能缺少文档和插入文字。
- `signature_help_get`：可选 `triggerCharacter`，返回 `signatures`、参数说明及 `activeSignature` / `activeParameter`，活动索引从 0 开始。最多返回 20 个签名、每个 40 个参数，检查 `parametersTruncated`。
- `type_definitions_get` / `implementations_get`：返回工作区内的 `locations`、`total` / `truncated`。
- `workspace_symbols_get`：`query`（1–1024 字符）、可选 `limit`，返回工作区内 `symbols`、`total` / `truncated`。
- `call_hierarchy_get`：位置参数、可选 `direction="incoming"`（或 `outgoing`）、`itemIndex=0`（0–199）、`limit`。返回可选调用项 `items`、所选索引 `selected`、`calls`、`total` / `truncated`。调用项和位置均过滤到工作区，最多 200 个准备项、每个调用最多 100 个范围，范围属于调用方。无调用层级提供者时 `items` / `calls` 为空。

正文及列表有长度上限；源于安装的语言插件，内容应作为不可信数据使用。错误码：`LANGUAGE_TIMEOUT`、`VERSION_CONFLICT`、`INVALID_RANGE` 和文件路径错误码。使用 [内置 Provider 命令](https://code.visualstudio.com/api/references/commands)。

## 调试器

`debug_configurations` 可在调试开关关闭时查询配置名称，其余调试工具需本机受信任工作区及 `vscodeMcp.debug.enabled=true`。权限独立于文件修改 / 修改确认 / 任务允许列表，启动已有配置可能执行 `preLaunchTask` 或程序代码。会话必须属于本窗口当前本机工作区；不提供任意调试配置、任意 DAP 请求或外部源码读取。

- `debug_configurations`：无参数，返回配置 `name` / `type` / `request` / `root`，不公开完整配置或环境变量。
- `debug_sessions`：无参数，返回会话 `sessionId`、名称、类型、根目录、`status`（`unknown` / `running` / `paused`）、`stopId` / `threadId` / `reason`。状态由调试器事件追踪，不表示执行成功。
- `debug_start`：`name`、可选 `root`，从已有 `launch.json` 选择唯一名称配置，返回 `started` 和会话列表。多根工作区需选根目录；不支持 compound 配置。
- `debug_stop`：`sessionId`，请求停止所选会话，可能终止程序，返回 `stopRequested`。
- `debug_breakpoints_get`：无参数，返回工作区源码断点。函数断点和外部源码断点不返回。
- `debug_breakpoint_add`：`path`、`line`、可选 `root` / `column=1` / `condition` / `hitCondition` / `logMessage`，返回 `breakpointId`。位置必须在文件内；`condition`、`hitCondition` 和 `logMessage` 需额外开启 `debug.allowEvaluation`。
- `debug_breakpoint_remove`：`breakpointId`，只允许移除工作区源码断点。
- `debug_threads`：`sessionId`，返回线程 ID 与名称（最多 200 个）。
- `debug_stack`：`sessionId`、当前 `stopId`、`threadId`、可选 `startFrame=0` / `levels=20`（1–100）。返回 `frames`、`totalFrames` / `nextStartFrame`，帧含 `frameId` / 名称 / 行列 / 工作区 `uri`；外部源码 `uri=null`。适配器可返回内部运行库帧。
- `debug_scopes`：`sessionId`、当前 `stopId`、来自 `debug_stack` 的 `frameId`，返回 `scopes`（最多 100 个），含可继续读取的 `variablesReference`。
- `debug_variables`：`sessionId`、当前 `stopId`、前序作用域 / 变量 / 求值返回的 `variablesReference`，可选 `start=0` / `count=50`（1–100）/ `filter="indexed"` 或 `"named"`。返回 `variables`、`total` / `nextStart`；值最多 4096 字符，检查 `valueTruncated`。为兼容忽略分页的调试器，获取后本地分页；展开可能触发调试器求值或程序 getter。
- `debug_control`：`sessionId`、`threadId`、`action`（`pause` / `continue` / `next` / `stepIn` / `stepOut`），除暂停外需当前 `stopId`。返回请求动作和最新观察状态，不保证已经暂停，应轮询 `debug_sessions`。
- `debug_evaluate`：`sessionId`、当前 `stopId`、已读取的 `frameId`、`expression`（1–4096 字符）。还需 `vscodeMcp.debug.allowEvaluation=true`，可能执行任意程序代码；以 `watch` 上下文求值。返回 `result`（最多 65536 字符）、`truncated` / `type` / 子变量引用。

每次暂停产生新的 `stopId`；继续 / 单步 / 再次暂停使旧帧与变量引用失效。响应期间状态改变也会被拒绝，必须重新读会话、栈和作用域。会话在插件加载前已暂停可能为 `unknown`，需要新的暂停事件。关闭权限使已授权引用失效，但不停止程序；卸载扩展也不会主动停止会话。DAP 请求限 10 秒；超时后不要假定动作没有发生，需检查当前状态。请求能力取决于调试器，拒绝时返回错误，不视为成功。

错误码：`DEBUG_DISABLED`、`DEBUG_EVALUATION_DISABLED`、`DEBUG_UNSUPPORTED`、`DEBUG_SESSION_NOT_FOUND`、`DEBUG_STATE_CHANGED`、`DEBUG_REFERENCE_INVALID`、`DEBUG_CONFIG_NOT_FOUND`、`DEBUG_START_FAILED`、`DEBUG_BREAKPOINT_NOT_FOUND`、`DEBUG_REQUEST_FAILED`、`DEBUG_TIMEOUT`、`WORKSPACE_UNTRUSTED` 和路径错误码。使用 [Debug API](https://code.visualstudio.com/api/references/vscode-api#debug)。

## 终端控制

所有终端工具需开启 `vscodeMcp.terminals.enabled` 并信任工作区，只支持本机窗口。此权限与 `allowWrites` / `requireApproval` / 任务允许列表独立；命令可访问工作区外。ID 仅在当前窗口有效。

- `terminals_list`：无参数，返回本窗口终端及 `terminalId`、`shellIntegration`、`outputSupported`、最近命令状态。
- `terminal_create`：可选 `name="MCP Terminal"`、`path="."`、`root`、`show=true`，使用默认 shell；初始目录必须是工作区内目录。最多 10 个 MCP 创建的终端。
- `terminal_write`：`terminalId`、`text`（最多 64 Ki 字符）、可选 `addNewLine=true` / `show=false`。支持控制字符，例如 `text="\u0003", addNewLine=false` 发送 Ctrl+C。`sent=true` 仅表示已发送输入，不表示执行完成。
- `terminal_execute`：`terminalId`、`command`（最多 64 Ki 字符）、可选 `show=false`。需 VS Code 1.93+ 及已初始化的 Shell Integration，立即返回，可能中断正在运行的命令。轮询 `terminal_read` 获取最近命令的状态和退出码。
- `terminal_read`：`terminalId`、可选 `offset=0` / `maxCharacters=65536`（1–65536），返回 `text`、`startOffset`、`nextOffset`、`endOffset`、`truncated`、`hasMore`、`status`、`exitCode`、`outputPending`、`outputError`。下一次传 `nextOffset`；偏移按 UTF-16 字符计算，`truncated=true` 表示请求起点已被淘汰。`completed` 和 `exitCode=0` 表示最近捕获的命令成功，`null` 不表示成功；`outputPending=true` 时输出尚未全部接收。原始输出含 ANSI 序列，仅包含开启权限后捕获的命令输出，不包含已有历史。每终端保留最后 256 Ki 字符，关闭后保留最近 20 个终端；不支持 Shell Integration 的终端可能始终无输出，不能据此判定命令成功。`outputError="OUTPUT_READ_FAILED"` 表示输出流读取失败。
- `terminal_close`：`terminalId`，关闭所选终端并终止其进程，返回 `closeRequested=true`；可关闭已有终端。

关闭权限清空所有缓存，重新开启后偏移从 0 开始。VS Code 1.85–1.92 支持终端创建 / 输入 / 关闭，读取和执行 API 返回 `SHELL_INTEGRATION_UNAVAILABLE`。新终端需等待 `shellIntegration=true` 才可使用 `terminal_execute`。不补读滚屏历史，不保证任务终端可捕获；使用 [VS Code Shell Integration API](https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecution)。

错误码：`TERMINALS_DISABLED`、`WORKSPACE_UNTRUSTED`、`TERMINAL_UNSUPPORTED`、`TERMINAL_NOT_FOUND`、`TERMINAL_LIMIT`、`SHELL_INTEGRATION_UNAVAILABLE`、`INVALID_RANGE`，目录校验沿用路径工具错误码。

## 文件与目录管理

- `resource_info`：`path`、可选 `root`，返回 `type`、`fingerprint`、目录树 `entries`、字节总量和 `dirty`。指纹覆盖所有节点的相对路径、类型、文件大小和磁盘内容摘要，不包含编辑器未保存修改。
- `directory_create`：`path`、可选 `root` / `preview=false`。只创建一个目录，父目录必须存在。
- `resource_move`：`path`、`target`、`expectedFingerprint`、可选 `root` / `preview=false`。支持文件和目录移动或重命名，不覆盖目标；相对目标使用同一个 `root`。
- `resource_delete`：`path`、`expectedFingerprint`、可选 `root` / `recursive=false` / `preview=false`。非空目录须指定 `recursive=true`。

移动和删除的 `expectedFingerprint` 来自 `resource_info`。开启 `requireApproval` 或指定 `preview=true` 时返回待确认提案；预览显示操作清单与资源快照。接受时重新校验指纹、权限和路径，资源发生变化返回 `VERSION_CONFLICT`。这些操作执行后立即改变磁盘；目录创建和目录删除不属于文本编辑撤销，目录删除直接通过文件系统执行，不进入回收站。资源操作不承诺磁盘层面的原子事务。

不允许管理工作区根目录、Git 元数据、符号链接或目录联接。移动或删除范围内包含未保存文档时返回 `DIRTY_DOCUMENT`。每次快照最多 1000 个节点、16 MiB 文件内容，包括二进制文件。

## 分页搜索

```json
{ "query": "TODO|FIXME", "regex": true, "glob": "src/**/*.ts", "exclude": ["**/generated/**"], "limit": 50 }
```

返回 `matches`、`scannedFiles`、`skippedFiles`、`scannedBytes`、`candidateFiles`、`completedFiles`、`nextCursor`、`discoveryTruncated` 和 `truncated`。匹配项带 `uri`、1-based `line` / `column`、匹配 `length`、`preview`、`isDirty` 和当时的 `contentHash`。

有 `nextCursor` 时继续请求 `{ "cursor": "上次返回的游标" }`；其他查询参数不用于更改已有搜索。每页最多扫描 200 文件、16 MiB 内容或约 5 秒，空匹配页也可能有下一页。达到匹配数量上限时，最后可能需要一页空结果确认结束。候选文件列表在新搜索时确定，文件内容在扫描时读取，包括未保存修改；跨页继续扫描同一个文件时若内容变化，返回 `SEARCH_CHANGED`。

游标一次性使用，5 分钟未继续失效；窗口内最多保留或处理 10 个搜索。默认发现最多 10000 个候选文件，通过侧边栏配置 `search.maxFiles`（100–50000）。达到候选上限时 `discoveryTruncated=true`，需提高上限或缩小 glob。`exclude` 可覆盖侧边栏 `search.exclude`；`.git` 始终排除。

正则按单行匹配，支持零宽匹配，列按 UTF-16 计数。正则在独立工作线程执行，单文件匹配超过 500ms 返回 `REGEX_TIMEOUT`，不会阻塞编辑器线程。不支持跨行匹配。

## 代码重构

- `file_format`：`path`、可选 `root`、`expectedHash`，可选 `tabSize`（1–16）和 `insertSpaces`。使用文件对应的格式化提供者。
- `symbol_rename`：`path`、可选 `root`、`line`、`column`、`newName`、`expectedHash`，调用符号重命名提供者，支持跨文件文字修改。
- `code_actions_get`：`path`、可选 `root`、`line`、`column`、可选 `endLine` / `endColumn`、`expectedHash`、`kind="quickfix"`、`limit=20`（最大 50）。返回操作的 `id`、`title`、`kind`、`previewable` 和不支持原因。
- `code_action_preview`：`actionId`，将此前查询的可预览操作放入确认队列。ID 5 分钟后失效。

格式化、重命名和快速修复预览始终先提交待确认提案，用户接受后才应用；默认不保存，与 `requireApproval` 是否开启无关。没有文字修改时返回 `changed=false`。主文档在提供者调用前后校验 `expectedHash`；所有受影响文件在提交预览和接受时校验摘要。

只转换已有工作区文本文件的 `TextEdit`，不执行原始 WorkspaceEdit 中的资源或笔记本操作；返回 `providerTextEditsOnly=true`。最多 20 个文件、每文件 1000 处修改，单文件结果不超过 1 MiB。快速修复若要求命令执行、已禁用或没有可用文字修改，则返回 `previewable=false`，不会运行命令。依赖已安装的语言服务，实际修改可在侧边栏逐文件查看。接口参考 [VS Code 内置 Provider 命令](https://code.visualstudio.com/api/references/commands)。

本版新增错误码：`PROTECTED_PATH`、`SYMLINK_UNSUPPORTED`、`RESOURCE_TOO_LARGE`、`DIRTY_DOCUMENT`、`DIRECTORY_NOT_EMPTY`、`TARGET_REQUIRED`、`INVALID_DESTINATION`、`QUERY_REQUIRED`、`INVALID_REGEX`、`REGEX_TIMEOUT`、`SEARCH_CHANGED`、`SEARCH_CURSOR_EXPIRED`、`SEARCH_LIMIT`、`SEARCH_FAILED`、`UNSUPPORTED_EDIT`、`ACTION_EXPIRED`。
