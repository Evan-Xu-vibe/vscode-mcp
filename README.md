# VSCode MCP

在 VS Code 桌面窗口内运行本地 MCP 服务，让外部 Agent 读取工作区和未保存代码、修改文件、查询诊断信息。支持 VS Code 1.85.0 及以上版本。

## 使用

1. 在扩展面板的菜单中选择 **Install from VSIX...**，安装 `vscode-mcp-0.5.0.vsix` 并重新加载窗口；或按下面的开发步骤运行。
2. 打开要提供给 Agent 的本机工作区。
3. 点击左侧活动栏的 **VSCode MCP** 插头图标，在“服务控制”侧边栏点击 **启动服务**。
4. 按需切换连接验证、设置 Key 和固定端口，点击 **立即重启以应用设置**。侧边栏分别显示当前生效验证和下次启动设置；端口被占用时会提示更换端口。
5. 点击 **复制客户端配置**，选择 Codex 或 OpenCode，直接复制含 URL 和可选 Key 的配置片段；也可只复制连接信息。
6. 按下面的客户端配置示例接入。让 Agent 先调用 `workspace_info`，核对工作区后再读写文件。

状态栏显示当前端口，点击可复制连接信息。服务默认手动启动，停止或关闭窗口后连接不可用。连接验证可选，默认开启：设置自定义 Key 后重启服务仍使用同一个 Key；未设置时每次启动生成随机 Key；关闭验证后无需凭据。默认端口每次启动也可能变化，可以在侧边栏指定固定端口。

所有插件配置均可在 **服务控制** 侧边栏操作，无需打开设置界面：点击连接验证、自动启动、文件修改、修改确认或任务执行即可切换；点击端口或 Key 输入值；点击 **配置允许的任务** 勾选已有任务，也可添加任务名称。取消全部勾选可清空任务允许列表。关闭选择框或输入框不会保存修改。窗口有工作区时写入工作区设置，否则写入用户设置；Key 始终保存在密钥存储中。

侧边栏提供 **连接自检**：检查 HTTP 服务响应、当前 Key、错误 Key 拒绝以及 MCP 初始化和工具发现。**最近外部请求** 显示请求时间与验证失败数量；**外部客户端初始化** 显示最近成功初始化的客户端名称和时间。自检请求不会计入外部记录；初始化记录表示曾成功接入，不表示客户端当前仍在线。服务重新启动后清空外部记录。

自定义 Key 支持 1–1024 个可打印 ASCII 字符，不包含空格，保存在 VS Code 密钥存储中。关闭验证时也可预先设置 Key，之后开启验证并重启服务即可使用。点击 **清除自定义 Key** 后，开启验证的服务下次启动会生成随机 Key。

## 接入 Codex

在 `%USERPROFILE%\.codex\config.toml` 中添加以下配置，替换示例 URL 和凭据。`Authorization` 的完整值可从复制的连接信息中取得。不要把真实凭据提交到仓库。

```toml
[mcp_servers.vscode]
url = "http://127.0.0.1:实际端口/mcp"
http_headers = { Authorization = "Bearer 实际凭据" }
```

关闭连接验证时，删除 `http_headers` 行，只保留 URL 即可。

重新连接 MCP 或重启客户端。配置格式参考 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。此版本已使用官方 MCP SDK 客户端做端到端验证，尚未在 Codex、OpenCode 产品中分别完成实测。

## 接入 OpenCode

将以下片段合并到 `opencode.json` 中，替换 URL 和凭据：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vscode": {
      "type": "remote",
      "url": "http://127.0.0.1:实际端口/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer 实际凭据" }
    }
  }
}
```

这里 `remote` 表示通过 HTTP 连接，服务实际仍运行在本机。参考 [OpenCode 官方 MCP 文档](https://opencode.ai/docs/mcp-servers/)。

关闭连接验证时，删除 `headers` 字段即可。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `workspace_info` | 窗口实例、工作区根目录、权限和限制 |
| `files_list` | 列出目录，支持分页 |
| `files_search` | 字面文本或逐行正则搜索，支持分页、自定义排除和大小写选项 |
| `file_read` | 读取最新编辑器内容，支持行范围及长度限制 |
| `file_write` | 创建文件或替换现有文件内容 |
| `file_apply_edits` | 对单文件应用多处不重叠的范围修改 |
| `file_save` | 保存指定文件 |
| `editor_context` | 当前文件、选区和已加载文档元数据 |
| `editor_open` | 打开工作区文件并定位 |
| `diagnostics_get` | 查询 VS Code 当前报告的错误和警告 |
| `files_write` | 批量修改前统一校验，再一次应用编辑 |
| `files_preview` / `proposal_get` | 提交修改预览并查询用户接受或拒绝的结果 |
| `git_status` / `git_diff` / `git_log` | 查询磁盘上的 Git 状态、差异和提交记录 |
| `symbols_get` / `definitions_get` / `references_get` | 通过语言服务查询文件符号、定义和引用 |
| `hover_get` / `completions_get` / `signature_help_get` | 查询悬浮说明、补全建议和函数签名，不应用补全或执行命令 |
| `type_definitions_get` / `implementations_get` | 查询类型定义和实现位置 |
| `workspace_symbols_get` / `call_hierarchy_get` | 搜索工作区符号，查询传入 / 传出调用关系 |
| `debug_configurations` / `debug_sessions` / `debug_start` / `debug_stop` | 列出已有调试配置与会话，启动 / 停止调试 |
| `debug_breakpoints_get` / `debug_breakpoint_add` / `debug_breakpoint_remove` | 查询、新增和移除工作区源码断点 |
| `debug_threads` / `debug_stack` / `debug_scopes` / `debug_variables` | 查询线程、暂停调用栈、作用域和变量 |
| `debug_control` / `debug_evaluate` | 暂停、继续、单步执行，以及独立授权的表达式求值 |
| `tasks_list` / `task_run` / `task_status` / `task_stop` | 列出已有任务，运行允许的任务、查询退出码和停止任务 |
| `terminals_list` / `terminal_create` / `terminal_close` | 列出、创建及关闭 VS Code 内置终端 |
| `terminal_write` / `terminal_execute` / `terminal_read` | 输入文字或控制字符、执行命令、增量读取命令输出和退出码 |
| `resource_info` | 获取文件或目录树的内容指纹，用于移动和删除前校验 |
| `directory_create` / `resource_move` / `resource_delete` | 创建目录、移动 / 重命名、删除文件或目录，支持预览确认 |
| `file_format` / `symbol_rename` | 通过语言服务格式化文件或重命名符号，始终先生成预览 |
| `code_actions_get` / `code_action_preview` | 获取快速修复 / 重构建议，再选择文字修改提交预览 |

详细参数、冲突行为和错误码见 [工具说明](docs/tools.md)。

## 修改预览、调用记录和任务

Agent 可用 `files_preview` 将修改放入 **待确认修改** 面板。点击文件查看原内容与拟修改内容的差异，再点击 **接受全部修改** 或 **拒绝全部修改**。接受时重新校验内容摘要、路径和权限；预览期间文件发生变化会使提案失败。预览支持新文件，接受前不会创建文件。

若希望所有文件修改和保存都先确认，在侧边栏点击 **修改前需要确认** 开启 `vscodeMcp.requireApproval`，立即生效。此时写入工具返回 `proposalId` 和 `status: "pending"`，Agent 应使用 `proposal_get` 查询状态。默认关闭，以兼容已有客户端。

**调用记录** 面板保留最近 200 次调用，显示工具、目标文件（悬停查看）、耗时和结果；可清空。记录仅保存在当前窗口内存中，不记录 Key、文件正文或完整参数。

任务执行默认关闭。在侧边栏点击 **允许执行任务** 开启，再点击 **配置允许的任务** 选择允许执行的任务名称，例如 `test`、`build`。Agent 先调用 `tasks_list` 取得 ID，再调用 `task_run`，使用返回的 `runId` 查询 `task_status`。任务通过 VS Code 执行，输出在任务终端中查看，MCP 返回状态和退出码；退出码未知时为 `null`，不能视为成功。仅支持本机工作区已有任务，不提供任意命令参数。任务 API 说明见 [VS Code 官方 API](https://code.visualstudio.com/api/references/vscode-api#tasks)。

Git 查询需要系统安装 Git，不执行提交、推送等修改操作；差异基于磁盘，不包含未保存的编辑器内容。符号、定义和引用查询依赖已安装的语言服务，只返回工作区内的位置。

## 终端读写

在服务控制侧边栏开启 **允许终端读写**（`vscodeMcp.terminals.enabled`，默认关闭），仅本机受信任工作区可用。Agent 可控制本窗口已有终端或创建新终端：先调用 `terminals_list` / `terminal_create` 获取 `terminalId`，再用 `terminal_write` 输入文字，或用 `terminal_execute` 执行命令并轮询 `terminal_read`。关闭终端用 `terminal_close`，会终止其中的进程。此权限独立于文件修改、修改确认和任务允许列表；终端命令按当前用户权限运行，可访问工作区外的文件及网络。

输入、创建和关闭兼容 VS Code 1.85+。读取输出和查询命令退出码需要 VS Code 1.93+ 及终端 Shell Integration；新终端可能需要等待其初始化。没有集成时仍可用 `terminal_write`，但不能保证捕获输出或退出码。使用官方 [Shell Integration API](https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecution)，仅捕获权限开启后命令产生的原始输出（含 ANSI 转义序列），不能补读已有滚屏历史、命令间提示符或不支持集成的任务终端。

Windows 上可选择 PowerShell 7 或 Git Bash 作为默认终端；Windows PowerShell 5 和 cmd 不支持这套 Shell Integration。可按 [官方安装说明](https://code.visualstudio.com/docs/terminal/shell-integration#_installation) 配置集成。

每个终端保留最近 256 Ki 个 UTF-16 字符，单次读取最多 64 Ki；下次请求传上次的 `nextOffset`。`truncated=true` 表示先前内容已被淘汰，`hasMore=true` 表示还有缓存未读。命令 `completed` 后仍需检查 `outputPending` 和 `exitCode`（`null` 表示未知）。`terminal_execute` 可能中断正在运行的命令；返回的状态对应最近捕获的命令。关闭权限立即停止捕获并清空缓存。关闭终端后保留最近 20 个终端的输出；每个窗口最多打开 10 个 MCP 创建的终端。停止 HTTP 服务不会关闭终端，终端由 VS Code 管理。

## 代码理解与调试

代码理解工具调用已安装语言服务，支持未保存文档；坐标按 1-based 行 / UTF-16 列计算。补全仅返回建议，不插入内容或执行补全命令；片段保留原始语法。类型定义、实现位置、工作区符号和调用关系仅返回工作区内的位置。没有对应语言插件时可能返回空结果；单次语言服务请求超过 10 秒返回 `LANGUAGE_TIMEOUT`。接口使用 [VS Code 内置语言服务命令](https://code.visualstudio.com/api/references/commands)。

调试默认关闭，在侧边栏开启 **允许调试控制**（`vscodeMcp.debug.enabled`）。仅支持本机受信任工作区及已有 `launch.json` 中的唯一名称配置，不接收任意调试配置或任意 DAP 请求。启动可能运行配置中的 `preLaunchTask`，此权限独立于任务允许列表。程序运行、单步和变量展开可能产生副作用；变量中可能包含敏感信息。条件断点 / 命中条件 / 日志表达式和 `debug_evaluate` 还需开启 **允许调试表达式求值**（`vscodeMcp.debug.allowEvaluation`），可能执行任意程序代码。

典型流程：`debug_configurations` → `debug_start` → `debug_sessions` → `debug_threads` → `debug_stack` → `debug_scopes` → `debug_variables`。暂停后从 `debug_sessions` 取得 `sessionId` / `stopId` / `threadId`；栈、作用域、变量和求值均需携带当前 `stopId`，帧与变量引用必须来自该暂停状态的前序返回。继续 / 单步 / 再次暂停使旧引用失效，返回 `DEBUG_STATE_CHANGED`，应重新查询。`debug_control` 使用 `pause`、`continue`、`next`、`stepIn`、`stepOut`；除暂停外均需当前 `stopId`。调试器不支持的请求返回 `DEBUG_REQUEST_FAILED`。单次 DAP 请求限 10 秒，超时不代表命令未执行，需重新检查状态。

会话状态从调试器事件追踪；已在插件启动前暂停的会话可能显示 `unknown`，需要观察一次新的暂停事件。关闭调试权限不会停止程序；停止服务 / 卸载扩展不会主动关闭已有调试会话。源文件路径限制在工作区，外部运行库帧仅返回名称及行列、`uri=null`，不提供外部源码读取。变量值并非工作区文件，仍可读取。实际能力依赖所选调试器，使用 [VS Code Debug API](https://code.visualstudio.com/api/references/vscode-api#debug)。

## 文件管理、搜索与重构

移动和删除前先调用 `resource_info` 获取 `fingerprint`，操作时提供 `expectedFingerprint`。资源工具支持二进制文件，目录树限制 1000 个节点和 16 MiB 文件内容。目标父目录必须存在，移动不覆盖已有目标。非空目录删除须显式指定 `recursive: true`。工作区根目录、Git 元数据和符号链接 / 目录联接受保护；存在未保存文档时禁止移动或删除。开启修改确认或传入 `preview: true` 后进入待确认面板，接受时重新检查状态。目录创建和资源操作会立即落盘；目录删除不进入回收站，也不支持文本编辑撤销。

搜索默认最多发现 10000 个候选文件，可以在侧边栏修改上限（100–50000）及排除 glob。每页最多扫描 200 个文件、16 MiB 正文或约 5 秒，结果有 `nextCursor` 时用它继续，包括匹配为空的页面。正则通过 `regex: true` 启用，按单行匹配；超过 500ms 的单文件匹配会被终止。`.git` 始终排除。候选发现达到上限时返回 `discoveryTruncated`，可以提高上限或缩小 glob。游标只使用一次，5 分钟未继续会失效。

格式化和符号重命名依赖对应语言服务；快速修复可先查询，再选择可预览的 `actionId`。这些操作只转换已有工作区文本文件的修改，始终需要用户在待确认面板接受，默认不保存。需要执行命令的快速修复不自动执行；语言服务建议中的资源操作和笔记本编辑不在文本预览范围内。没有语言服务或无需修改时可能返回空结果。

## 文件读写约定

- `path` 支持绝对本机路径、`file:` URI、相对工作区路径。多根工作区的相对路径必须附带 `workspace_info` 返回的 `root` URI。
- `file_read` 读取编辑器缓冲区，包括未保存修改；`contentHash` 始终对应完整内容，即使只读取部分行。
- 修改现有文件和保存时必须提供 `expectedHash`。若用户或其他客户端改变了内容，会返回 `VERSION_CONFLICT`，需要重新读取。
- 编辑现有文件默认不保存，可用 `save: true` 或单独调用 `file_save`。修改支持 VS Code 撤销/重做。
- 创建文件用 `create: true`；父目录必须存在。创建操作会先在磁盘创建空文件，然后将正文放入编辑器；用 `save: true` 将正文保存到磁盘。
- 行号和列号从 1 开始，列按 UTF-16 计数，修改范围结束位置不包含在内；读取的 `endLine` 则包含该行。
- VS Code 会按文档设置处理换行和编码，保存参与者可能执行格式化；以返回的内容摘要和后续读取结果为准。

## 设置和边界

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `vscodeMcp.autoStart` | `false` | 窗口启动后自动运行服务，修改后重新加载窗口 |
| `vscodeMcp.port` | `0` | 自动分配端口，可设置固定端口；修改后重启服务 |
| `vscodeMcp.auth.enabled` | `true` | 是否要求 Bearer Key；可关闭验证，修改后重启服务 |
| `vscodeMcp.allowWrites` | `true` | 是否允许创建、修改和保存文件，立即生效 |
| `vscodeMcp.requireApproval` | `false` | 修改与保存先进入待确认修改面板，立即生效 |
| `vscodeMcp.tasks.enabled` | `false` | 是否允许执行任务，仅受信任工作区可用 |
| `vscodeMcp.terminals.enabled` | `false` | 独立控制终端读写，默认关闭；读取输出需要 VS Code 1.93+ 和 Shell Integration |
| `vscodeMcp.debug.enabled` | `false` | 允许调试启动 / 停止、断点、单步、调用栈及变量读取 |
| `vscodeMcp.debug.allowEvaluation` | `false` | 允许调试表达式求值、条件断点与日志表达式；需同时开启调试 |
| `vscodeMcp.tasks.allowedNames` | `[]` | 允许执行的任务名称，精确匹配 |
| `vscodeMcp.search.exclude` | 依赖 / 构建目录 | 搜索排除 glob，可从侧边栏增删；`.git` 始终排除 |
| `vscodeMcp.search.maxFiles` | `10000` | 候选文件上限，100–50000，可分页继续扫描 |

服务仅监听 `127.0.0.1`，验证开启时使用自定义或随机 Bearer Key，所有模式均检查 Host/Origin；路径限定在工作区，拒绝指向工作区外的符号链接和目录联接。未受信任工作区禁止文件修改。每个窗口有独立服务，随机 Key 每次启动生成，自定义 Key 由此扩展的密钥存储保存。

当前支持本机文本文件和 Streamable HTTP 的无状态 JSON 响应模式，不提供 SSE 事件订阅、stdio 桥接或远程工作区。单个文本文件限制 1 MiB，单次读取最多 64 Ki 个字符；HTTP 请求体最多 2 MiB；批量修改最多 20 个文件。搜索每页最多返回 200 个匹配，默认排除依赖、Git 和构建目录。结果中的 `nextCursor`、`discoveryTruncated`、`skippedFiles` 必须检查。诊断为空不代表语言服务已完成检查。

## 开发

1. 安装 Node.js 22 或更新的 LTS 版本（包含 npm）。
2. 在工程目录执行 `npm.cmd ci`。
3. 用 VS Code 打开当前目录，按 **F5**，启动插件开发宿主。
4. 在新窗口按 **Ctrl+Shift+P**，执行 **VSCode MCP: 启动 MCP 服务**。

修改代码后执行 `npm.cmd run compile`，在开发宿主执行 **Developer: Reload Window** 重新加载插件；持续打包可以使用 `npm.cmd run watch`。插件运行不依赖用户机器上的 npm，npm 仅用于工程开发。

修改 `package.json` 中的配置或命令声明后，需要重新加载开发宿主窗口（或关闭宿主后重新按 F5），仅编译代码不会重新注册配置。若切换验证时报“没有注册配置 vscodeMcp.auth.enabled”，请先重新加载窗口。未打开工作区时，验证开关保存到用户设置；打开工作区时保存到工作区设置。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd run compile` | 类型检查、编译并打包运行代码 |
| `npm.cmd run watch` | 监听并重新打包，类型检查另用 check |
| `npm.cmd run check` | 类型检查 |
| `npm.cmd test` | 单元测试和真实 VS Code 集成测试 |
| `npm.cmd run test:unit` | 仅运行单元与 HTTP 协议测试 |
| `npm.cmd run package` | 生成 VSIX 安装包 |

集成测试默认下载 VS Code 1.85.0，并使用独立临时工作区和配置；可指定已安装的 VS Code 来避免下载：

```powershell
$env:VSCODE_EXECUTABLE_PATH = 'E:\Software\Microsoft VS Code\Code.exe'
npm.cmd test
```

测试覆盖 57 个工具的发现、请求认证、连接自检与外部请求区分、路径越界、未保存内容、修改冲突、批量预校验、资源创建 / 移动 / 删除及确认、超过 200 文件的分页搜索、正则超时、排除配置、重构预览、Git 查询、任务退出码与停止、终端权限 / 输入 / 输出分页 / 退出码、客户端配置复制及固定端口重启。Windows 上设置 `MCP_TEST_SHELL` 为 PowerShell 7 的可执行文件路径，并使用 VS Code 1.93+，可额外验证真实终端 Shell Integration 输出读取。

设置 MCP_TEST_DEBUG=1 可启用真实 Node.js 调试集成测试，覆盖调用栈、作用域、变量、表达式求值、单步和暂停引用失效；测试宿主需包含内置 JavaScript 调试器。

## 工程结构

- `src/extension.ts`：插件入口、服务管理、状态栏和用户命令。
- `src/server.ts`：本机 HTTP 服务、连接验证和 MCP 传输。
- `src/tools.ts`：工作区与文件工具、批量预校验与修改队列。
- `src/advanced.ts`：Git、语言服务和任务工具。
- `src/review.ts`：修改提案、差异预览与确认面板。
- `src/history.ts`：调用记录面板。
- `src/tasks.ts`：VS Code 任务执行与状态追踪。
- `src/terminals.ts`：内置终端控制、Shell Integration 输出捕获和增量读取。
- `src/language.ts`：悬浮、补全、签名、类型定义、实现、工作区符号与调用层级查询。
- `src/debugger.ts`：调试权限、会话与暂停状态、断点、DAP 查询和控制。
- `src/connection.ts`：客户端配置生成。
- `src/resources.ts`：文件 / 目录快照与管理工具。
- `src/search.ts`：分页搜索、排除规则与正则工作线程。
- `src/refactor.ts`：语言服务修改转换与重构预览。
- `src/core.ts`：路径边界、摘要和写入队列。
- `src/test/`：协议、边界和 VS Code 集成测试。
- `scripts/`：构建和测试入口。
- `package.json`：插件清单、命令声明和开发脚本。
- `.vscode/launch.json`：F5 调试配置。
- `.vscode/tasks.json`：调试前编译和打包。

运行代码打包到 `dist/extension.js`，VSIX 不包含开发依赖和测试代码。发布到 Marketplace 前，需要设置自己的 `publisher`、仓库信息和许可证。

参考：[VS Code 官方插件开发指南](https://code.visualstudio.com/api/get-started/your-first-extension)。
